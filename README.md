# RotinaBoot Pro 🚀
Uma utilidade web de alta fidelidade para criação de drives USB inicializáveis, inspirada no Rufus e desenvolvida com foco em precisão e experiência do utilizador.

## ✨ Funcionalidades
- **Seleção de Imagem Real:** Suporte para carregamento de ficheiros `.iso`, `.img` e `.zip`.
- **Deteção de Hardware:** Utiliza a API WebUSB para interagir com dispositivos físicos (em ambientes compatíveis).
- **Personalização de Boot:**
  - Esquemas de partição: **GPT** e **MBR**.
  - Sistemas de destino: **UEFI (non-CSM)** e **BIOS**.
  - Sistemas de ficheiros: **FAT32**, **NTFS** e **exFAT**.
- **Interface Pro:** Interface moderna em modo Dark/Light com animações fluidas via Framer Motion.
- **Log de Eventos:** Terminal embutido para monitorização detalhada de cada etapa do processo.

## 🛠️ Tecnologias
- **React 19** + **TypeScript**
- **Vite** (Build System)
- **Tailwind CSS 4** (Styling)
- **Motion** (Animações)
- **Lucide React** (Ícones)
- **WebUSB API** (Interação com hardware)

## 🚀 Como Executar Localmente
Se exportar este projeto e quiser correr na sua máquina:

1. Instale as dependências:
```bash
npm install
```

2. Inicie o servidor de desenvolvimento:
```bash
npm run dev
```

3. Abra o browser em `http://localhost:3000`.

## 📄 Licença
Este projeto foi gerado no Google AI Studio. Sinta-se à vontade para o modificar e utilizar conforme necessário.
