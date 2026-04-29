'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// ─── Estado Global ────────────────────────────────────────────────────────────
let mainWindow = null;
let burnProcess = null;  // referência ao processo filho activo
let cancelRequested = false;

// ─── Criação da Janela ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 840,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.cjs')
    },
    icon: path.join(__dirname, 'public/icon.ico')
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Helper: enviar progresso para o renderer ─────────────────────────────────
function sendProgress(percent, message, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('burn-progress', { percent, message, type });
  }
}

// ─── IPC: Listar Drives USB (Windows via WMIC / PowerShell) ──────────────────
ipcMain.handle('list-drives', async () => {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Usa PowerShell para listar drives removíveis
      const cmd = `powershell -NoProfile -Command "Get-Disk | Where-Object {$_.BusType -eq 'USB'} | Select-Object Number, FriendlyName, Size | ConvertTo-Json -Compress"`;
      exec(cmd, (err, stdout) => {
        if (err || !stdout.trim()) {
          // Fallback: listar via WMI
          const cmd2 = `wmic diskdrive where "InterfaceType='USB'" get DeviceID,Model,Size /format:csv`;
          exec(cmd2, (err2, stdout2) => {
            if (err2) return resolve([]);
            const lines = stdout2.trim().split('\n').slice(2).filter(l => l.trim());
            const drives = lines.map(l => {
              const parts = l.split(',');
              const deviceId = (parts[1] || '').trim();
              const model = (parts[2] || 'USB Drive').trim();
              const sizeBytes = parseInt((parts[3] || '0').trim()) || 0;
              const sizeGB = (sizeBytes / (1024 ** 3)).toFixed(1);
              if (!deviceId) return null;
              return {
                index: 0,
                label: model,
                size: `${sizeGB} GB`,
                path: deviceId
              };
            }).filter(Boolean);
            resolve(drives);
          });
          return;
        }

        try {
          let parsed = JSON.parse(stdout.trim());
          if (!Array.isArray(parsed)) parsed = [parsed];
          const drives = parsed.map(d => ({
            index: d.Number,
            label: d.FriendlyName || `Disk ${d.Number}`,
            size: `${(d.Size / (1024 ** 3)).toFixed(1)} GB`,
            path: `\\\\.\\PhysicalDrive${d.Number}`
          }));
          resolve(drives);
        } catch {
          resolve([]);
        }
      });
    } else {
      // Linux/macOS: lisar via lsblk
      exec('lsblk -J -o NAME,SIZE,RM,TRAN,VENDOR,MODEL', (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout);
          const drives = (data.blockdevices || [])
            .filter(d => d.rm === true || d.rm === '1')
            .map(d => ({
              index: 0,
              label: `${d.vendor || ''} ${d.model || d.name}`.trim(),
              size: d.size,
              path: `/dev/${d.name}`
            }));
          resolve(drives);
        } catch {
          resolve([]);
        }
      });
    }
  });
});

// ─── IPC: Selecionar ficheiro ISO ─────────────────────────────────────────────
ipcMain.handle('select-iso', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar Imagem ISO',
    filters: [{ name: 'Imagens de Disco', extensions: ['iso', 'img'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ─── IPC: Cancelar operação ───────────────────────────────────────────────────
ipcMain.on('cancel-burn', () => {
  cancelRequested = true;
  if (burnProcess) {
    try { burnProcess.kill('SIGTERM'); } catch {}
  }
});

// ─── IPC: Formatar e Gravar ISO na Pen USB ────────────────────────────────────
ipcMain.on('format-and-burn', async (event, opts) => {
  const { isoPath, drivePath, partitionScheme, targetSystem, fileSystem, volumeLabel } = opts;
  cancelRequested = false;

  const isWindows = process.platform === 'win32';

  try {
    // Validações básicas
    if (!fs.existsSync(isoPath)) {
      sendProgress(0, `Erro: Ficheiro ISO não encontrado: ${isoPath}`, 'error');
      return;
    }

    sendProgress(2, 'A verificar ISO...', 'info');
    const isoStat = fs.statSync(isoPath);
    const isoSizeMB = (isoStat.size / (1024 * 1024)).toFixed(0);
    sendProgress(5, `ISO verificada: ${isoSizeMB} MB`, 'success');

    if (cancelRequested) return;

    // ── WINDOWS: usar diskpart + xcopy / 7-zip ────────────────────────────────
    if (isWindows) {
      await burnWindows({ isoPath, drivePath, partitionScheme, targetSystem, fileSystem, volumeLabel, isoSizeMB });
    } else {
      // ── LINUX/macOS: usar parted + dd + mount ─────────────────────────────
      await burnUnix({ isoPath, drivePath, partitionScheme, fileSystem, volumeLabel });
    }

  } catch (err) {
    sendProgress(0, `Erro fatal: ${err.message || err}`, 'error');
  }
});

// ─── Windows: Diskpart + extração com 7zip / robocopy ────────────────────────
async function burnWindows({ isoPath, drivePath, partitionScheme, targetSystem, fileSystem, volumeLabel, isoSizeMB }) {
  // Extrair número do disco a partir do path (\\\\.\\PhysicalDriveX)
  const diskNumber = drivePath.replace(/\D/g, '');
  if (!diskNumber) {
    sendProgress(0, `Erro: Não foi possível extrair o número do disco de: ${drivePath}`, 'error');
    return;
  }

  sendProgress(8, `Disco alvo: Disk ${diskNumber} | Esquema: ${partitionScheme} | FS: ${fileSystem}`, 'info');

  // Script diskpart para formatar
  const fsMap = { FAT32: 'FAT32', NTFS: 'NTFS', exFAT: 'exFAT' };
  const fsType = fsMap[fileSystem] || 'FAT32';
  const labelSafe = (volumeLabel || 'BOOTUSB').substring(0, 11);

  const diskpartScript = partitionScheme === 'GPT'
    ? [
        'rescan',
        `select disk ${diskNumber}`,
        'clean',
        'convert gpt',
        'create partition primary',
        `format fs=${fsType} label="${labelSafe}" quick`,
        'assign',
        'exit'
      ].join('\r\n')
    : [
        'rescan',
        `select disk ${diskNumber}`,
        'clean',
        'convert mbr',
        'create partition primary',
        `format fs=${fsType} label="${labelSafe}" quick`,
        'select partition 1',
        'active',
        'assign',
        'exit'
      ].join('\r\n');

  const scriptPath = path.join(os.tmpdir(), 'rotinaboot_diskpart.txt');
  fs.writeFileSync(scriptPath, diskpartScript, 'ascii');

  sendProgress(12, 'A formatar unidade USB via Diskpart...', 'info');

  await new Promise((resolve, reject) => {
    burnProcess = exec(`diskpart /s "${scriptPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
      burnProcess = null;
      if (cancelRequested) return reject(new Error('Cancelado'));
      if (err) return reject(new Error(`Diskpart falhou: ${stderr || err.message}`));
      resolve();
    });
  });

  if (cancelRequested) { sendProgress(0, 'Operação cancelada.', 'error'); return; }

  sendProgress(30, 'Formatação concluída. A detetar letra da drive...', 'success');

  // Aguardar que o Windows atribua letra à drive
  await sleep(2000);

  // Encontrar letra da drive formatada
  const driveLetter = await findDriveLetter(diskNumber);
  if (!driveLetter) {
    sendProgress(35, 'Aviso: Não foi possível detectar letra. A usar montagem via 7-Zip...', 'warn');
    // Copiar via montagem de ISO (fallback)
    await extractISODirect(isoPath, diskNumber);
    return;
  }

  sendProgress(35, `Unidade montada em ${driveLetter}:\\. A extrair ISO...`, 'success');

  // Montar a ISO e copiar conteúdo
  await mountAndCopy(isoPath, driveLetter, diskNumber);
}

// Encontrar letra da drive pelo número do disco
async function findDriveLetter(diskNumber) {
  return new Promise((resolve) => {
    // Tenta obter a letra da unidade associada ao disco. 
    // Filtramos para garantir que a partição tenha uma letra de unidade atribuída.
    const cmd = `powershell -NoProfile -Command "Get-Partition -DiskNumber ${diskNumber} | Where-Object { $_.DriveLetter } | Select-Object -First 1 DriveLetter | ConvertTo-Json -Compress"`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      try {
        const data = JSON.parse(stdout.trim());
        const letter = data.DriveLetter;
        resolve(letter && letter !== '' ? letter : null);
      } catch {
        // Fallback: se não for JSON, pode ser a letra direta
        const letterMatch = stdout.match(/"DriveLetter":\s*"([A-Z])"/i);
        if (letterMatch) return resolve(letterMatch[1]);
        resolve(null);
      }
    });
  });
}

// Montar ISO e copiar conteúdo para a drive USB
async function mountAndCopy(isoPath, driveLetter, diskNumber) {
  if (cancelRequested) return;

  // Montar ISO via PowerShell
  sendProgress(40, 'A montar imagem ISO...', 'info');

  const mountCmd = `powershell -NoProfile -Command "
    $imagePath = '${isoPath.replace(/'/g, "''")}';
    $mounted = Get-DiskImage -ImagePath $imagePath;
    if (-not $mounted.Attached) {
      Mount-DiskImage -ImagePath $imagePath -StorageType ISO -PassThru | Get-Volume | Select-Object -First 1 DriveLetter | ConvertTo-Json -Compress
    } else {
      $mounted | Get-Volume | Select-Object -First 1 DriveLetter | ConvertTo-Json -Compress
    }"`;

  const isoLetter = await new Promise((resolve) => {
    exec(mountCmd, { timeout: 60000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        // Se falhar o JSON, tentamos pegar qualquer letra que pareça drive letter
        const letterMatch = stdout.match(/"DriveLetter":\s*"([A-Z])"/i);
        if (letterMatch) return resolve(letterMatch[1]);
        return resolve(null);
      }
      try {
        const data = JSON.parse(stdout.trim());
        resolve(data.DriveLetter || null);
      } catch {
        resolve(null);
      }
    });
  });

  if (!isoLetter) {
    sendProgress(42, 'Falha ao montar ISO via PowerShell. A tentar 7-Zip...', 'warn');
    await extractISODirect(isoPath, diskNumber);
    return;
  }

  sendProgress(50, `ISO montada em ${isoLetter}:\\. A copiar ficheiros...`, 'success');

  if (cancelRequested) {
    await dismountISO(isoPath);
    sendProgress(0, 'Cancelado.', 'error');
    return;
  }

  // Copiar conteúdo da ISO montada para a pen
  await new Promise((resolve, reject) => {
    const robocopy = spawn('robocopy', [
      `${isoLetter}:\\`,
      `${driveLetter}:\\`,
      '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'
    ]);

    burnProcess = robocopy;
    let totalFiles = 0;
    let copiedFiles = 0;

    robocopy.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('-')) {
          copiedFiles++;
          const pct = Math.min(50 + Math.floor((copiedFiles / Math.max(totalFiles, 500)) * 45), 95);
          sendProgress(pct, `A copiar: ${trimmed.substring(0, 60)}`, 'info');
        }
      }
    });

    robocopy.on('close', (code) => {
      burnProcess = null;
      // Robocopy retorna 0-7 em sucesso
      if (cancelRequested) return reject(new Error('Cancelado'));
      if (code <= 7) resolve();
      else reject(new Error(`Robocopy falhou com código ${code}`));
    });
  });

  await dismountISO(isoPath);

  if (!cancelRequested) {
    // Tornar bootável (bootsect para BIOS ou apenas GPT/UEFI)
    sendProgress(96, 'A finalizar configuração de boot...', 'info');
    try {
      await applyBootSector(driveLetter);
    } catch {}

    sendProgress(100, '✅ Pen USB bootável criada com sucesso!', 'success');
  }
}

// Desmontar ISO
async function dismountISO(isoPath) {
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "Dismount-DiskImage -ImagePath '${isoPath.replace(/'/g, "''")}'"`, () => resolve());
  });
}

// Aplicar sector de boot (para compatibilidade BIOS)
async function applyBootSector(driveLetter) {
  return new Promise((resolve, reject) => {
    // bootsect.exe está disponível em algumas instalações Windows
    const bootsectPaths = [
      `${driveLetter}:\\boot\\bootsect.exe`,
      `C:\\Windows\\System32\\bootsect.exe`
    ];
    const bootsect = bootsectPaths.find(p => fs.existsSync(p));
    if (!bootsect) return resolve(); // não essencial para UEFI

    exec(`"${bootsect}" /nt60 ${driveLetter}: /mbr`, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Extração direta via 7-Zip (fallback)
async function extractISODirect(isoPath, diskNumber) {
  sendProgress(45, 'Modo Fallback: A tentar extração com 7-Zip...', 'warn');

  const sevenZipPaths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.resourcesPath || __dirname, '7z.exe')
  ];
  const sevenZip = sevenZipPaths.find(p => fs.existsSync(p));

  if (!sevenZip) {
    sendProgress(0, 'Erro: 7-Zip não encontrado. Instale o 7-Zip para continuar.', 'error');
    sendProgress(0, 'Download: https://www.7-zip.org/', 'warn');
    return;
  }

  const tmpDir = path.join(os.tmpdir(), 'rotinaboot_iso_extract');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir);

  sendProgress(48, `A extrair ISO para directório temporário...`, 'info');

  await new Promise((resolve, reject) => {
    burnProcess = spawn(sevenZip, ['x', isoPath, `-o${tmpDir}`, '-y']);

    burnProcess.stdout.on('data', (data) => {
      const match = data.toString().match(/(\d+)%/);
      if (match) {
        const pct = 48 + Math.floor(parseInt(match[1]) * 0.25);
        sendProgress(pct, `A extrair: ${match[1]}%`, 'info');
      }
    });

    burnProcess.on('close', (code) => {
      burnProcess = null;
      if (cancelRequested) return reject(new Error('Cancelado'));
      if (code === 0) resolve();
      else reject(new Error(`7-Zip falhou com código ${code}`));
    });
  });

  // Encontrar letra da drive
  await sleep(1000);
  const driveLetter = await findDriveLetter(diskNumber);
  if (!driveLetter) {
    sendProgress(0, 'Erro: Não foi possível localizar a drive formatada para copiar os ficheiros.', 'error');
    return;
  }

  sendProgress(75, `A copiar ficheiros extraídos para ${driveLetter}:\\...`, 'info');

  await new Promise((resolve, reject) => {
    burnProcess = spawn('robocopy', [tmpDir, `${driveLetter}:\\`, '/E', '/NFL', '/NDL', '/NJH', '/NJS']);

    burnProcess.on('close', (code) => {
      burnProcess = null;
      if (cancelRequested) return reject(new Error('Cancelado'));
      resolve();
    });
  });

  // Limpar temporários
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  sendProgress(100, '✅ Pen USB bootável criada com sucesso! (via 7-Zip)', 'success');
}

// ─── Linux/macOS: parted + dd ─────────────────────────────────────────────────
async function burnUnix({ isoPath, drivePath, partitionScheme, fileSystem, volumeLabel }) {
  const isRoot = process.getuid && process.getuid() === 0;
  if (!isRoot) {
    sendProgress(0, 'Erro: Necessita de permissões de root (sudo) para escrever na drive.', 'error');
    return;
  }

  sendProgress(10, `A limpar e reparticionar ${drivePath}...`, 'info');
  await execAsync(`parted ${drivePath} --script mklabel ${partitionScheme === 'GPT' ? 'gpt' : 'msdos'}`);
  await execAsync(`parted ${drivePath} --script mkpart primary ${fileSystem.toLowerCase()} 1MiB 100%`);

  sendProgress(25, 'A formatar partição...', 'info');
  const partition = `${drivePath}${drivePath.endsWith('p') ? '' : ''}1`;
  const label = (volumeLabel || 'BOOTUSB').substring(0, 11);

  if (fileSystem === 'FAT32') {
    await execAsync(`mkfs.vfat -F 32 -n "${label}" ${partition}`);
  } else if (fileSystem === 'NTFS') {
    await execAsync(`mkfs.ntfs -f -L "${label}" ${partition}`);
  } else {
    await execAsync(`mkfs.exfat -n "${label}" ${partition}`);
  }

  sendProgress(40, 'Partição formatada. A montar ISO e copiar conteúdo...', 'success');

  const mountISO = `/mnt/rotinaboot_iso_${Date.now()}`;
  const mountUSB = `/mnt/rotinaboot_usb_${Date.now()}`;
  fs.mkdirSync(mountISO, { recursive: true });
  fs.mkdirSync(mountUSB, { recursive: true });

  try {
    await execAsync(`mount -o loop "${isoPath}" ${mountISO}`);
    await execAsync(`mount ${partition} ${mountUSB}`);

    sendProgress(50, 'A copiar ficheiros da ISO...', 'info');

    await new Promise((resolve, reject) => {
      burnProcess = spawn('rsync', ['-a', '--info=progress2', `${mountISO}/`, `${mountUSB}/`]);

      burnProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+)%/);
        if (match) {
          const pct = 50 + Math.floor(parseInt(match[1]) * 0.45);
          sendProgress(pct, `A copiar: ${match[1]}%`, 'info');
        }
      });

      burnProcess.on('close', (code) => {
        burnProcess = null;
        if (cancelRequested) return reject(new Error('Cancelado'));
        if (code === 0) resolve();
        else reject(new Error(`rsync falhou com código ${code}`));
      });
    });

    sendProgress(97, 'A sincronizar disco...', 'info');
    await execAsync('sync');

  } finally {
    try { await execAsync(`umount ${mountISO}`); } catch {}
    try { await execAsync(`umount ${mountUSB}`); } catch {}
    try { fs.rmdirSync(mountISO); fs.rmdirSync(mountUSB); } catch {}
  }

  sendProgress(100, '✅ Pen USB bootável criada com sucesso!', 'success');
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}
