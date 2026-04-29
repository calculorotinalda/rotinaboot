import React, { useState, useEffect, useRef } from 'react';
import { 
  Usb, 
  FileSearch, 
  Settings, 
  Play, 
  X, 
  Terminal, 
  ShieldCheck, 
  HardDrive, 
  Info,
  ChevronDown,
  ChevronRight,
  Loader2,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  FileCode,
  Zap,
  ExternalLink,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---

type PartitionScheme = 'MBR' | 'GPT';
type TargetSystem = 'BIOS' | 'UEFI';
type FileSystem = 'FAT32' | 'NTFS' | 'exFAT';

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'warn' | 'error' | 'success';
}

interface DiskDrive {
  index: number;
  label: string;
  size: string;
  /** ex: "\\\\.\\PhysicalDrive1" */
  path: string;
}

declare global {
  interface Window {
    electronAPI?: {
      listDrives: () => Promise<DiskDrive[]>;
      formatAndBurn: (opts: {
        isoPath: string;
        drivePath: string;
        partitionScheme: string;
        targetSystem: string;
        fileSystem: string;
        volumeLabel: string;
      }) => void;
      onProgress: (cb: (data: { percent: number; message: string; type: string }) => void) => void;
      offProgress: (cb: (data: { percent: number; message: string; type: string }) => void) => void;
      cancelBurn: () => void;
      selectIso: () => Promise<string | null>;
    };
  }
}

// --- Main Component ---

export default function App() {
  // Real State
  const [isoPath, setIsoPath] = useState<string | null>(null);
  const [isoName, setIsoName] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [drives, setDrives] = useState<DiskDrive[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string>('');
  const [isLoadingDrives, setIsLoadingDrives] = useState(false);

  // Settings
  const [partitionScheme, setPartitionScheme] = useState<PartitionScheme>('GPT');
  const [targetSystem, setTargetSystem] = useState<TargetSystem>('UEFI');
  const [volumeLabel, setVolumeLabel] = useState('ROTINABOOT');
  const [fileSystem, setFileSystem] = useState<FileSystem>('FAT32');

  // App State
  const [isBurning, setIsBurning] = useState(false);
  const isBurningRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Pronto');
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isIframe, setIsIframe] = useState(false);
  const [isElectron, setIsElectron] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check for environment on mount
  useEffect(() => {
    setIsIframe(window.self !== window.top);
    const electron = !!window.electronAPI;
    setIsElectron(electron);

    if (electron) {
      loadDrives();

      // Listen for real-time progress from Electron backend
      const handleProgress = (data: { percent: number; message: string; type: string }) => {
        setProgress(data.percent);
        setStatusText(data.message);
        addLog(data.message, data.type as LogEntry['type']);

        if (data.percent >= 100) {
          isBurningRef.current = false;
          setIsBurning(false);
        }
      };

      window.electronAPI!.onProgress(handleProgress);
      return () => {
        window.electronAPI!.offProgress(handleProgress);
      };
    }
  }, []);

  // Auto-update label when ISO changes
  useEffect(() => {
    if (isoName) {
      const baseName = isoName.split('.')[0].substring(0, 11).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      setVolumeLabel(baseName);
    }
  }, [isoName]);

  useEffect(() => {
    if (selectedFile) {
      const baseName = selectedFile.name.split('.')[0].substring(0, 11).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      setVolumeLabel(baseName);
      addLog(`Ficheiro carregado: ${selectedFile.name} (${(selectedFile.size / (1024*1024*1024)).toFixed(2)} GB)`, 'info');
    }
  }, [selectedFile]);

  // Scroll to bottom of logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const newEntry: LogEntry = {
      id: Math.random().toString(36).substr(2, 6),
      timestamp: new Date().toLocaleTimeString(),
      message,
      type
    };
    setLogs(prev => [...prev, newEntry]);
  };

  const loadDrives = async () => {
    if (!window.electronAPI) return;
    setIsLoadingDrives(true);
    addLog('A listar unidades de disco...', 'info');
    try {
      const list = await window.electronAPI.listDrives();
      setDrives(list);
      if (list.length > 0) {
        setSelectedDrive(list[0].path);
        addLog(`${list.length} unidade(s) encontrada(s).`, 'success');
      } else {
        addLog('Nenhuma unidade USB encontrada. Ligue uma Pen Drive.', 'warn');
      }
    } catch (err) {
      addLog(`Erro ao listar unidades: ${err}`, 'error');
    } finally {
      setIsLoadingDrives(false);
    }
  };

  const selectIsoElectron = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectIso();
    if (path) {
      setIsoPath(path);
      setIsoName(path.split(/[\\/]/).pop() || path);
      addLog(`ISO selecionada: ${path}`, 'info');
    }
  };

  const startProcess = async () => {
    const hasISO = isElectron ? !!isoPath : !!selectedFile;
    const hasDrive = isElectron ? !!selectedDrive : true;

    if (!hasISO) {
      addLog('Erro: Por favor, selecione um ficheiro ISO primeiro.', 'error');
      return;
    }

    if (isElectron && !hasDrive) {
      addLog('Erro: Por favor, selecione uma unidade USB de destino.', 'error');
      return;
    }

    const driveName = isElectron
      ? drives.find(d => d.path === selectedDrive)?.label || selectedDrive
      : 'USB Virtual';

    const confirmFormat = window.confirm(
      `⚠️ AVISO CRÍTICO ⚠️\n\nTODOS OS DADOS EM "${driveName}" SERÃO PERMANENTEMENTE ELIMINADOS.\n\n` +
      `ISO: ${isElectron ? isoName : selectedFile?.name}\n` +
      `Esquema: ${partitionScheme} | Sistema: ${targetSystem} | FS: ${fileSystem}\n\n` +
      `Deseja continuar?`
    );

    if (!confirmFormat) {
      addLog('Processo cancelado pelo utilizador.', 'warn');
      return;
    }

    isBurningRef.current = true;
    setIsBurning(true);
    setProgress(0);
    setLogs([]);
    setStatusText('A iniciar...');

    addLog(`Iniciando criação de bootable ${partitionScheme}/${targetSystem}...`, 'info');

    if (isElectron && isoPath) {
      // ── MODO REAL: Electron com acesso nativo ao sistema ──
      window.electronAPI!.formatAndBurn({
        isoPath,
        drivePath: selectedDrive,
        partitionScheme,
        targetSystem,
        fileSystem,
        volumeLabel,
      });
      // O progresso vem via onProgress listener registado no useEffect
    } else {
      // ── MODO SIMULAÇÃO: Browser sem acesso nativo ──
      addLog('⚠️ Modo Simulação: Sem acesso nativo ao disco. Use o App Desktop para escrita real.', 'warn');

      const steps = [
        { msg: 'A calcular checksum MD5 da ISO...', duration: 1500 },
        { msg: `A formatar drive USB (${driveName})...`, duration: 2500 },
        { msg: `A criar tabela de partições ${partitionScheme}...`, duration: 1500 },
        { msg: `A preparar sistema de ficheiros ${fileSystem}...`, duration: 2000 },
        { msg: `A montar imagem: ${selectedFile?.name}...`, duration: 4500 },
        { msg: `A copiar ficheiros de boot para a Pen...`, duration: 3500 },
        { msg: 'A validar integridade dos dados...', duration: 1500 },
        { msg: 'A finalizar e ejetar unidade...', duration: 1000 },
      ];

      let currentProgress = 0;
      const totalSteps = steps.length * 20;
      const progressPerSubStep = 100 / totalSteps;

      for (const step of steps) {
        if (!isBurningRef.current) break;
        setStatusText(step.msg);
        addLog(step.msg);

        const subSteps = 20;
        for (let j = 0; j < subSteps; j++) {
          if (!isBurningRef.current) break;
          await new Promise(r => setTimeout(r, step.duration / subSteps));
          currentProgress += progressPerSubStep;
          setProgress(Math.min(currentProgress, 100));
        }
      }

      if (isBurningRef.current) {
        addLog('SIMULAÇÃO CONCLUÍDA. (Nenhuma escrita real foi efetuada)', 'success');
        setStatusText('Pronto');
        isBurningRef.current = false;
        setIsBurning(false);
      }
    }
  };

  return (
    <div className="min-h-screen py-8 flex flex-col items-center justify-center p-4 bg-[#f8fafc] dark:bg-[#0f172a]">
      <motion.div 
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-[500px] rufus-panel bg-white dark:bg-[#1e293b] border-2 border-blue-500 shadow-2xl relative overflow-hidden"
      >
        {/* Subtle background glow */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-blue-500/10 blur-3xl rounded-full" />
        
        {/* Header */}
        <div className="relative flex items-center justify-between mb-6 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2.5 rounded-xl text-white shadow-lg shadow-blue-200 dark:shadow-none">
              <Zap size={22} fill="white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-gray-800 dark:text-gray-100 tracking-tight">RotinaBoot <span className="text-blue-600">Pro</span></h1>
              <span className="text-[10px] text-gray-400 uppercase font-black tracking-widest">USB Forge Studio</span>
            </div>
          </div>
          <div className="flex gap-1 border-l border-gray-100 dark:border-gray-800 pl-4 py-1">
            {isIframe && (
              <a 
                href={window.location.href} 
                target="_blank" 
                rel="noopener noreferrer"
                className="p-2 rounded-lg transition-all hover:bg-blue-600 hover:text-white text-blue-500 bg-blue-50 dark:bg-blue-900/20"
                title="Abrir em Nova Aba (Necessário para USB)"
              >
                <ExternalLink size={18} />
              </a>
            )}
            <button 
              onClick={() => setShowLogs(!showLogs)}
              className={`p-2 rounded-lg transition-all ${showLogs ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400'}`}
              title="Mostrar Consola de Log"
            >
              <Terminal size={18} />
            </button>
          </div>
        </div>

        {/* Environment Badge */}
        {!isElectron && (
          <div className="mb-4 flex items-center gap-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-400 text-[10px] font-bold uppercase tracking-widest px-3 py-2 rounded-lg">
            <AlertTriangle size={12} />
            Modo Simulação — Para escrita real, use o App Desktop
          </div>
        )}
        {isElectron && (
          <div className="mb-4 flex items-center gap-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400 text-[10px] font-bold uppercase tracking-widest px-3 py-2 rounded-lg">
            <ShieldCheck size={12} />
            Modo Nativo — Acesso completo ao hardware USB ativo
          </div>
        )}

        <div className="relative space-y-5">
          {/* Hardware & File */}
          <section className="bg-blue-50/50 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-100/50 dark:border-blue-900/30">
            <div className="rufus-section-title text-blue-700 dark:text-blue-400 font-bold mb-3">
              <HardDrive size={14} /> Seleção de Hardware e Imagem
            </div>
            <div className="space-y-4">
              {/* Drive selector */}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Dispositivo USB</label>
                  {isElectron ? (
                    <select
                      value={selectedDrive}
                      onChange={(e) => setSelectedDrive(e.target.value)}
                      disabled={isBurning || isLoadingDrives}
                      className="rufus-input h-10 border-gray-200 dark:border-gray-700 font-medium cursor-pointer"
                    >
                      {drives.length === 0 && (
                        <option value="">— Nenhuma unidade encontrada —</option>
                      )}
                      {drives.map(d => (
                        <option key={d.path} value={d.path}>💽 {d.label} ({d.size})</option>
                      ))}
                    </select>
                  ) : (
                    <select disabled className="rufus-input h-10 border-gray-200 dark:border-gray-700 font-medium opacity-60">
                      <option>USB Virtual Simulation (32GB)</option>
                    </select>
                  )}
                </div>
                {isElectron && (
                  <button
                    onClick={loadDrives}
                    disabled={isBurning || isLoadingDrives}
                    className="h-10 px-3 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-all disabled:opacity-50"
                    title="Atualizar lista de drives"
                  >
                    <RefreshCw size={16} className={isLoadingDrives ? 'animate-spin' : ''} />
                  </button>
                )}
              </div>

              {/* ISO selector */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Imagem ISO / Imagem de Boot</label>
                  <div className="relative group">
                    <div className={`rufus-input h-10 border-gray-200 dark:border-gray-700 flex items-center px-10 truncate ${!(isoName || selectedFile) ? 'text-gray-400 italic' : 'text-gray-700 dark:text-gray-300'}`}>
                       {isElectron ? (isoName || 'Nenhum ficheiro selecionado...') : (selectedFile ? selectedFile.name : 'Nenhum ficheiro selecionado...')}
                    </div>
                    <FileCode size={18} className="absolute left-3 top-2.5 text-gray-400" />
                    {!isElectron && (
                      <input 
                        type="file" 
                        accept=".iso,.img,.zip" 
                        className="hidden" 
                        ref={fileInputRef}
                        onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                      />
                    )}
                  </div>
                </div>
                <button 
                  onClick={isElectron ? selectIsoElectron : () => fileInputRef.current?.click()}
                  disabled={isBurning}
                  className="mt-5 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold text-xs shadow-md shadow-blue-200 dark:shadow-none transition-all uppercase"
                >
                  Selecionar
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Esquema de Partição</label>
                  <select 
                    value={partitionScheme}
                    onChange={(e) => setPartitionScheme(e.target.value as PartitionScheme)}
                    disabled={isBurning}
                    className="rufus-input border-gray-200 dark:border-gray-700"
                  >
                    <option value="GPT">GPT (Moderno)</option>
                    <option value="MBR">MBR (Legado)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Sistema de Destino</label>
                  <select 
                    value={targetSystem}
                    onChange={(e) => setTargetSystem(e.target.value as TargetSystem)}
                    disabled={isBurning}
                    className="rufus-input border-gray-200 dark:border-gray-700"
                  >
                    <option value="UEFI">UEFI (Não CSM)</option>
                    <option value="BIOS">BIOS (Modo Legado)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          {/* Format Settings */}
          <section className="px-4">
            <div className="rufus-section-title text-gray-400 font-bold text-[9px]">
               Opções de Formatação Pro
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Rótulo do Volume</label>
                  <input 
                    type="text" 
                    value={volumeLabel}
                    onChange={(e) => setVolumeLabel(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 11))}
                    disabled={isBurning}
                    maxLength={11}
                    className="rufus-input h-10 border-gray-200 dark:border-gray-700"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Sist. Ficheiros</label>
                  <select 
                    value={fileSystem}
                    onChange={(e) => setFileSystem(e.target.value as FileSystem)}
                    disabled={isBurning}
                    className="rufus-input border-gray-200 dark:border-gray-700"
                  >
                    <option value="FAT32">FAT32 (Recomendado)</option>
                    <option value="NTFS">NTFS</option>
                    <option value="exFAT">exFAT</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase mb-1 block">Tam. Cluster</label>
                  <select disabled={isBurning} className="rufus-input border-gray-200 dark:border-gray-700 opacity-60">
                    <option>Padrão (4096 bytes)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          {/* Progress & Actions */}
          <section className="pt-4 space-y-4">
            <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[10px] font-black text-gray-400 uppercase tracking-widest">
                    <span className={isBurning ? 'text-blue-500 animate-pulse' : ''}>{statusText}</span>
                    <span>{Math.round(progress)}%</span>
                </div>
                <div className="h-3 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden border border-gray-200 dark:border-gray-700 p-0.5">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className={`h-full rounded-full transition-all ${progress === 100 ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.3)]'}`}
                  />
                </div>
            </div>

            <div className="flex gap-3">
              {!isBurning ? (
                <button 
                  onClick={startProcess}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-black py-3.5 rounded-xl shadow-lg shadow-blue-200 dark:shadow-none flex items-center justify-center gap-2 transition-all active:scale-95 group"
                >
                  <Play size={18} fill="white" className="group-hover:scale-110 transition-transform" /> INICIAR
                </button>
              ) : (
                <button 
                  onClick={() => { 
                    isBurningRef.current = false;
                    if (window.electronAPI) window.electronAPI.cancelBurn();
                    setIsBurning(false); 
                    setStatusText('Cancelado'); 
                    addLog('Operação cancelada pelo utilizador.', 'error'); 
                  }}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white font-black py-3.5 rounded-xl shadow-lg shadow-red-100 dark:shadow-none flex items-center justify-center gap-2 transition-all"
                >
                  <X size={18} /> CANCELAR
                </button>
              )}
            </div>
          </section>
        </div>

        {/* Dynamic Log Drawer */}
        <AnimatePresence>
          {showLogs && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 200, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mt-6 font-mono text-[10px] bg-gray-900 text-gray-300 rounded-xl p-3 overflow-y-auto border-2 border-gray-800 shadow-inner"
              ref={logContainerRef}
            >
              {logs.map(log => (
                <div key={log.id} className="mb-1 leading-relaxed">
                  <span className="text-gray-500">[{log.timestamp}]</span>{' '}
                  <span className={
                    log.type === 'success' ? 'text-green-400' : 
                    log.type === 'warn' ? 'text-yellow-400' : 
                    log.type === 'error' ? 'text-red-400 font-bold' : ''
                  }>
                    {log.message}
                  </span>
                </div>
              ))}
              {logs.length === 0 && <div className="text-center py-10 opacity-20 italic">A aguardar eventos de sistema...</div>}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-8 pt-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-[10px] text-gray-400 font-black uppercase tracking-widest">
            <div className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-green-500" /> {isElectron ? 'Kernel Nativo' : 'Modo Simulação'}</div>
            <div className="flex gap-4">
                <span className="text-blue-500 cursor-help hover:underline">v5.0 PRO</span>
                <span className="bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-500">Stable Build</span>
            </div>
        </div>
      </motion.div>
    </div>
  );
}
