const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');
const { chromium, devices } = require('playwright');
const { faker } = require('@faker-js/faker');
const si = require('systeminformation');
const { exec, spawn } = require('child_process');
const { executarOtimizacoes } = require('./optimizer');
const { globalShortcut } = require('electron');
const { salvarPosicoes, carregarPosicoes } = require('./posicoesManager');
const { garantirArquivo } = require('./fileUtils');
const { resetarPosicoesParaPadrao } = require('./posicoesManager');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const MirrorController = require('./mirrorController');

let tokenGlobal = null;
let usuarioGlobal = null;
let painelWin;

const MERCADO_PAGO_TOKEN = "APP_USR-4133785617893000-081123-a06cf0900848f7b8208534c74f6abffe-183947567";

const mirrorController = new MirrorController(() => contexts, { concurrency: 8 });


ipcMain.on('mirror-event', (_event, payload) => {
    try {
        console.log('[main] mirror-event recebido:', payload && payload.type);
        mirrorController.handleEvent(payload);
    } catch (e) {
        console.error('[main] erro ao processar mirror-event:', e);
    }
});

// ativa/desativa o espelhamento
ipcMain.handle('toggle-mirror', async (_event, enable) => {
    try {
        const newState = mirrorController.toggle(
            typeof enable === 'boolean' ? enable : undefined
        );
        console.log('[main] toggle-mirror =>', newState);

        if (newState) {
            await injectMirrorCaptureToSource();
        }

        return { success: true, enabled: newState };
    } catch (err) {
        console.error('Erro em toggle-mirror handle:', err);
        return { success: false, error: String(err) };
    }
});


// -------------------------------------------------------------------
//  FUNÇÃO DE INJETAR CAPTURA NA ABA 0
// -------------------------------------------------------------------
async function injectMirrorCaptureToSource() {
    if (!contexts.length) {
        console.log('[mirror] nenhuma aba aberta');
        return;
    }
    const source = contexts[0].page;
    if (!source) {
        console.log('[mirror] aba 0 sem page');
        return;
    }

    // expõe função que manda pro main
    try {
        await source.exposeFunction('_sendMirrorExposed', (ev) => {
            ipcMain.emit('mirror-event', null, ev);
        });
        console.log('[mirror] exposeFunction _sendMirrorExposed injetado');
    } catch (e) {
        console.log('[mirror] exposeFunction já existe');
    }

    const MIRROR_CAPTURE = `
(function(){
  if (window.__mirrorCaptureInstalled) return;
  window.__mirrorCaptureInstalled = true;

  function safeSend(obj) {
    try { if (window._sendMirrorExposed) window._sendMirrorExposed(obj); } catch(e) {}
  }

  // CLICK (já tinha)
  document.addEventListener('click', e => {
    safeSend({
      type:'click',
      ratioX: e.clientX / (window.innerWidth || 1),
      ratioY: e.clientY / (window.innerHeight || 1),
      button: e.button,
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey
    });
  }, true);

  // KEYDOWN (atalhos)
  document.addEventListener('keydown', e => {
    safeSend({
      type:'key',
      key: e.key,
      code: e.code,                // ex: "KeyA", "Enter"
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey
    });
  }, true);

  // WHEEL (👈 novo — espelha rolagem por delta no ponto do cursor)
  document.addEventListener('wheel', e => {
    safeSend({
      type: 'wheel',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ratioX: e.clientX / (window.innerWidth || 1),
      ratioY: e.clientY / (window.innerHeight || 1),
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey
    });
  }, { capture: true, passive: true });

  // SCROLL (fallback absoluto; pode manter)
  let _t;
  window.addEventListener('scroll', () => {
    clearTimeout(_t);
    _t = setTimeout(() => {
      safeSend({
        type: 'scroll',
        ratioX: (window.scrollX || 0) / Math.max(1, (document.documentElement.scrollWidth  || window.innerWidth)  - window.innerWidth),
        ratioY: (window.scrollY || 0) / Math.max(1, (document.documentElement.scrollHeight || window.innerHeight) - window.innerHeight),
      });
    }, 40);
  }, { capture: true, passive: true });
})();
`;


    await source.addInitScript({ content: MIRROR_CAPTURE });
    await source.evaluate(MIRROR_CAPTURE);

    console.log('[mirror] captura injetada na aba 0');
}

ipcMain.handle('criar-pagamento-pix', async (_event, { valor, descricao, email }) => {
    try {
        const response = await fetch("https://api.mercadopago.com/v1/payments", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${MERCADO_PAGO_TOKEN}`,
                "Content-Type": "application/json",
                "X-Idempotency-Key": uuidv4()
            },
            body: JSON.stringify({
                transaction_amount: Number(valor), 
                description: descricao,
                payment_method_id: "pix",
                payer: { email }
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(data));

        return { success: true, pagamento: data };
    } catch (err) {
        console.error("[PIX] Erro:", err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('verificar-pagamento', async (_event, paymentId) => {
    if (!paymentId) return { pago: false, error: 'paymentId missing' };
    try {
        const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${MERCADO_PAGO_TOKEN}` }
        });
        const data = await res.json();

        const pago = data.status === 'approved' || data.status === 'paid';

        const rawAmount = data.transaction_amount ?? data.amount ?? data.transaction_amount_paid ?? data.transaction_amount_refunded ?? null;
        const valorPago = rawAmount != null ? Number(rawAmount) : NaN;

        const pid = data.id ?? data.payment_id ?? data.external_reference ?? paymentId;

        return { pago, status: data.status, raw: data, valorPago, paymentId: pid };
    } catch (err) {
        console.error('Erro verificar-pagamento:', err);
        return { pago: false, error: err.message };
    }
});

ipcMain.handle('salvar-proxies-txt', async (event, { defaultName, content }) => {
    try {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Salvar proxies',
            defaultPath: defaultName || `proxies_${Date.now()}.txt`,
            filters: [{ name: 'Text', extensions: ['txt'] }]
        });

        if (canceled || !filePath) return { success: false, canceled: true };

        await fsPromises.writeFile(filePath, content, { encoding: 'utf8' });

        return { success: true, path: filePath };
    } catch (err) {
        console.error('salvar-proxies-txt erro:', err);
        return { success: false, error: String(err) };
    }
});

ipcMain.handle('obter-proxies', async (_event, { paymentId, quantidade }) => {
    console.log('[main] Chamando API de obter proxies', { paymentId, quantidade });

    try {
        const API_BASE = process.env.API_URL || 'https://server-production-0a24.up.railway.app';
        const pid = encodeURIComponent(String(paymentId || '').trim());
        const count = Number(quantidade) || 10;

        const url = `${API_BASE.replace(/\/$/, '')}/proxies-por-pagamento?paymentId=${pid}&count=${count}`;
        console.log('[main] fetch ->', url);

        const r = await fetch(url, { method: 'GET' });
        const json = await r.json().catch(() => null);

        console.log('[main] obter-proxies resposta http:', r.status, 'json:', json);
        return json || { success: false, error: 'Resposta inválida da API' };
    } catch (err) {
        console.error('[main] erro obter-proxies:', err);
        return { success: false, error: String(err) };
    }
});

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'playwright-browsers');

require('dotenv').config();
console.log('API_URL carregada do .env:', process.env.API_URL);

const isPackaged = app.isPackaged;

const chromiumPath = isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers", "chromium-1181", "chrome-win", "chrome.exe")
    : path.join(__dirname, "resources", "playwright-browsers", "chromium-1181", "chrome-win", "chrome.exe");

const chromiumExecutablePath = chromiumPath;
const abaStoragePath = path.join(app.getPath('userData'), 'abas-storage');
if (!fs.existsSync(abaStoragePath)) fs.mkdirSync(abaStoragePath);

let contexts = [];
let mirrorDesiredState = false;


ipcMain.handle('set-mobile-mode', (_e, newMode) => {
    mobileMode = newMode;
    mirror.setMode(mobileMode); 
});

ipcMain.handle('salvar-posicoes-abas', async () => {
    console.log('[main] recebida requisição para salvar posições');
    if (contexts.length === 0) {
        console.warn('[main] não há abas abertas para salvar');
        return { success: false, error: 'Nenhuma aba aberta. Abra abas antes de salvar posições.' };
    }

    try {
        await salvarPosicoes(contexts);
        console.log('[main] salvarPosicoes() executado com sucesso');
        return { success: true };
    } catch (err) {
        console.error('[main] erro ao salvar posições:', err);
        return { success: false, error: err.message };
    }
});
ipcMain.handle('resetar-posicoes', async (event) => {
    try {
        resetarPosicoesParaPadrao();
        console.log('IPC: Posições resetadas com sucesso.');
        return { success: true };
    } catch (error) {
        console.error('IPC: Erro ao resetar posições:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('executar-otimizacoes', async (event, tarefas) => {
    try {
        await executarOtimizacoes(tarefas);
        return true;
    } catch (err) {
        console.error('Erro ao otimizar:', err);
        throw err;
    }
});
ipcMain.handle('executar-tarefa-individual', async (event, tarefa) => {
    console.log(`🛠️ Executando tarefa: ${tarefa}`);
    try {
        await executarOtimizacoes([tarefa]);
    } catch (e) {
        console.error(`Erro ao executar tarefa '${tarefa}':`, e);
    }
});
function getCpuUsage() {
    return new Promise((resolve) => {
        const start = os.cpus();

        setTimeout(() => {
            const end = os.cpus();
            let idleDiff = 0;
            let totalDiff = 0;

            for (let i = 0; i < start.length; i++) {
                const startCpu = start[i].times;
                const endCpu = end[i].times;

                const idle = endCpu.idle - startCpu.idle;
                const total = Object.values(endCpu).reduce((acc, val) => acc + val, 0)
                    - Object.values(startCpu).reduce((acc, val) => acc + val, 0);

                idleDiff += idle;
                totalDiff += total;
            }

            const cpuPercent = 100 - (idleDiff / totalDiff) * 100;
            resolve(cpuPercent);
        }, 100); 
    });
}

function getRamUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    return ((1 - free / total) * 100);
}

function getGpuUsage() {
    return new Promise((resolve) => {
        exec('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', (err, stdout) => {
            if (err || !stdout) return resolve('--');
            const usage = parseFloat(stdout.trim());
            resolve(isNaN(usage) ? '--' : usage.toFixed(1));
        });
    });
}

ipcMain.handle('getSystemUsage', async () => {
    try {
        const [cpu, ram, gpu] = await Promise.all([
            getCpuUsage(),
            getRamUsage(),
            getGpuUsage()
        ]);

        return {
            cpu: isFinite(cpu) ? cpu.toFixed(1) : '--',
            ram: isFinite(ram) ? ram.toFixed(1) : '--',
            gpu
        };
    } catch (e) {
        console.error('Erro no getSystemUsage:', e);
        return { cpu: '--', ram: '--', gpu: '--' };
    }
});

const mobileDevices = [
    'iPhone 6', 'iPhone 6 Plus', 'iPhone 7', 'iPhone 8', 'iPhone 8 Plus', 'iPhone SE', 'iPhone X', 'iPhone XR',
    'iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max', 'iPhone 12', 'iPhone 12 Pro', 'iPhone 13', 'iPhone 13 Pro',
    'iPhone 14', 'iPhone 14 Pro', 'Pixel 2', 'Pixel 4', 'Pixel 5', 'Galaxy Note 3', 'Galaxy Note II', 'Galaxy S III',
    'Galaxy S5', 'Galaxy S8', 'Galaxy S9+', 'Microsoft Lumia 950', 'Blackberry Z30', 'Nexus 4', 'Nexus 5',
    'Nexus 5X', 'Nexus 6', 'Nexus 6P', 'JioPhone 2'
];
const desktopDevice = {};


let browserDesktop = null;
let lastParams = null;
let contasCriadasPersistentes = [];
let usuarioLogado = null;

const contasFilePath = path.join(app.getPath('userData'), 'contasCriadas.json');
const storageStatesDir = path.join(app.getPath('userData'), 'storageStates');
if (!fs.existsSync(storageStatesDir)) fs.mkdirSync(storageStatesDir);


let cpfsDisponiveis = []; 

function limparCPF(cpf) {
    return cpf.replace(/[.\-]/g, '').trim();
}

function obterCpfValido() {
    while (cpfsDisponiveis.length > 0) {
        const cpf = limparCPF(cpfsDisponiveis.shift());
        if (/^\d{11}$/.test(cpf)) {
            return cpf;
        }
    }
    return null;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 400,
        height: 500,
        minWidth: 400,
        minHeight: 500,
        resizable: false,
        frame: true,
        icon: "lala.ico",
        backgroundColor: '#2b2b2b',
        show: false, 
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false,
            backgroundThrottling: false,
            sandbox: false,
            additionalArguments: [
                `--apiUrl=${process.env.API_URL}`,
                `--clientVersion=${app.getVersion()}`
            ]
        }
    });

    win.removeMenu();

    win.loadFile('login.html');

    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' }; // impede abrir no próprio Electron
    });

    win.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            win.show();
        
        }, 1000); 
    });

    // --- substitua o handler antigo por este ---
    const fetch = globalThis.fetch || (() => {
        try { return require('node-fetch'); } catch (e) { return null; }
    })();

    ipcMain.on('login-sucesso', async (event, dados) => {
        const fs = require('fs');
        console.log('📩 login-sucesso recebido (main):', JSON.stringify(dados));
        usuarioGlobal = dados.usuario || usuarioGlobal;
        tokenGlobal = dados.token || tokenGlobal;

        if (!dados || !dados.usuario) {
            console.error('nenhum dado recebido no login sucesso', dados);
            return;
        }
        usuarioLogado = dados.usuario;

        if (!win || win.isDestroyed()) {
            console.error('Janela principal não encontrada ou destruída');
            return;
        }

        // Ajustes de tamanho do futuro launcher (valores que você usava)
        const TARGET_WIDTH = 700;
        const TARGET_HEIGHT = 580;

        // Versão cliente
        const clientVersion = (app && typeof app.getVersion === 'function') ? app.getVersion() : (process.env.CLIENT_VERSION || '0.0.0');
        console.log('Versão do cliente:', clientVersion);

        // busca versão no servidor
        const API_BASE = (process.env.API_URL || 'https://server-production-0a24.up.railway.app').replace(/\/$/, '');
        let versaoAtual = null;
        let versaoOk = false;
        try {
            const fetchFn = globalThis.fetch || require('node-fetch');
            if (!fetchFn) throw new Error('fetch não disponível no main');
            const res = await fetchFn(`${API_BASE}/versao`, { method: 'GET', headers: { 'Accept': 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            versaoAtual = json.versao_atual || json.versao || null;
            if (versaoAtual) {
                const normalize = s => String(s || '').trim();
                versaoOk = normalize(versaoAtual) === normalize(clientVersion);
            } else {
                console.warn('/versao retornou sem versao_atual:', json);
                versaoOk = true; // política permissiva por padrão
            }
        } catch (err) {
            console.error('Erro ao buscar /versao:', err);
            versaoOk = true; // política permissiva por padrão
        }

        const fileToLoad = versaoOk ? 'launcher.html' : 'desatualizado.html';
        const filePath = path.join(__dirname, fileToLoad);
        console.log(`-> Preloading ${fileToLoad} (versaoAtual=${versaoAtual} versaoOk=${versaoOk})`);

        // Se o arquivo alvo não existir, tenta fallback imediato
        if (!fs.existsSync(filePath)) {
            console.error('Arquivo alvo não encontrado:', filePath);
            // fallback: recarrega login (ou desatualizado se desejar)
            try { await win.loadFile(path.join(__dirname, 'login.html')); } catch (e) { console.error(e); }
            if (!win.isVisible()) win.show();
            return;
        }

        // 1) cria janela oculta para pré-carregar o arquivo (mesmas webPreferences mínimas)
        const preloadPath = path.join(__dirname, 'preload.js');
        const hiddenWin = new BrowserWindow({
            show: false,
            webPreferences: {
                preload: preloadPath,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });

        // listener para timeout / erro caso algo trave (segurança)
        let timedOut = false;
        const t = setTimeout(() => {
            timedOut = true;
            try { if (!hiddenWin.isDestroyed()) hiddenWin.destroy(); } catch (_) { }
        }, 8000); // 8s timeout (ajuste se quiser)

        try {
            // 2) carrega a página no hiddenWin
            await hiddenWin.loadFile(filePath);

            // Se timeout já ocorreu, aborta
            if (timedOut) {
                console.warn('Preload timeout — abortando swap para', fileToLoad);
                return;
            }

            // 3) agora que a página está pronta no hiddenWin, ajusta o tamanho do win principal
            try {
                win.setMinimumSize(TARGET_WIDTH, TARGET_HEIGHT);
                win.setSize(TARGET_WIDTH, TARGET_HEIGHT);
                win.center();
            } catch (e) {
                console.warn('Erro ao redimensionar janela principal:', e);
            }

            // 4) finalmente, carrega o arquivo no win principal (rápido, pois já foi pré-carregado)
            await win.loadFile(filePath);

            // garante visibilidade e foco
            if (!win.isVisible()) win.show();
            win.focus();

            // chama iniciarVerificacao se existir
            try { if (typeof iniciarVerificacao === 'function') iniciarVerificacao(usuarioGlobal); } catch (e) { console.warn('iniciarVerificacao falhou:', e); }

        } catch (preErr) {
            console.error('Erro no pré-load ou swap de página:', preErr);
            // fallback: tenta abrir desatualizado ou recarregar login
            try {
                const fallback = path.join(__dirname, versaoOk ? 'desatualizado.html' : 'login.html');
                if (fs.existsSync(fallback)) await win.loadFile(fallback);
                else await win.loadURL('about:blank');
                if (!win.isVisible()) win.show();
            } catch (e) {
                console.error('Erro ao carregar fallback:', e);
            }
        } finally {
            clearTimeout(t);
            try { if (!hiddenWin.isDestroyed()) hiddenWin.destroy(); } catch (_) { }
        }
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
        }
    });
}

let verificadorInterval = null;

function iniciarVerificacao(usuario, token) {
    if (!usuario) {
        console.warn('iniciarVerificacao chamado sem usuário.');
        return;
    }

    console.log("Iniciando verificação para:", usuario);

    if (verificadorInterval) {
        clearInterval(verificadorInterval);
        verificadorInterval = null;
    }

    let fetchFn = globalThis.fetch;
    try {
        if (!fetchFn) {
            
            fetchFn = require('node-fetch'); 
        }
    } catch (e) {
        console.warn('node-fetch não disponível; fetch pode falhar se não houver global fetch.');
    }

    verificadorInterval = setInterval(async () => {
        try {
            const url = token ? `${process.env.API_URL}/user/status` : `${process.env.API_URL}/status/${encodeURIComponent(usuario)}`;

            const headers = { 'Accept': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetchFn(url, { method: 'GET', headers, timeout: 10000 });

            if (!resp.ok) {
                console.warn(`Verificação retornou status ${resp.status}. Tratando como inativo/erro.`);
                if (resp.status === 401 || resp.status === 403) {
                    await handleLogout(usuario, `Código ${resp.status} recebido`);
                    return;
                }
                return;
            }

            const dados = await resp.json();

            const ativo = typeof dados.ativo === 'boolean' ? dados.ativo : !!dados.ativo;

            if (!ativo) {
                console.log(`⛔ Usuário ${usuario} inativo (API retornou ativo=false), retornando ao login...`);
                await handleLogout(usuario, 'ativo=false');
            }
        } catch (err) {
            console.error("Erro ao verificar status:", err);
        }
    }, 5000);
}

async function handleLogout(usuario, motivo) {
    try {
        if (verificadorInterval) {
            clearInterval(verificadorInterval);
            verificadorInterval = null;
        }
        console.log(`Logout automático para ${usuario}. Motivo: ${motivo}`);

        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            win.setBounds({ width: 400, height: 500 });
            try { win.webContents.executeJavaScript(`localStorage.removeItem('token')`).catch(() => { }); } catch (e) { }
            win.loadFile('login.html');
        }
    } catch (e) {
        console.error('Erro no handleLogout:', e);
    }
}

async function addIpOverlay(page, ip) {
    await page.evaluate((ip) => {
        if (document.getElementById('ip-overlay')) return;
        const div = document.createElement('div');
        div.id = 'ip-overlay';
        div.textContent = `IP: ${ip}`;
        Object.assign(div.style, {
            position: 'fixed',
            bottom: '5px',
            right: '5px',
            backgroundColor: 'rgba(0,0,0,0.6)',
            color: 'white',
            padding: '3px 8px',
            fontSize: '12px',
            fontFamily: 'Arial, sans-serif',
            zIndex: 9999999,
            borderRadius: '4px',
            userSelect: 'none',
        });
        document.body.appendChild(div);
    }, ip);
}
const ABA_WIDTH = 500;
const ABA_HEIGHT = 500;
const ABA_OFFSET_LEFT = 0;
const ABA_OFFSET_TOP = 0;
const ABAS_POR_LINHA = 5;

const MOBILE_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt'] });
  window.chrome = { runtime: {} };
  const original = navigator.permissions.query;
  navigator.permissions.__proto__.query = params =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : original(params);
`;


let painelWindow = null;
const painelConfigPath = path.join(__dirname, "painel-config.json");
const boundsFile = path.join(__dirname, "painelBounds.json");

function loadBounds() {
    try {
        if (fs.existsSync(boundsFile)) {
            return JSON.parse(fs.readFileSync(boundsFile, "utf8"));
        }
    } catch (err) {
        console.error("Erro ao ler bounds:", err);
    }
    return { width: 300, height: 500 };
}

function saveBounds(bounds) {
    try {
        fs.writeFileSync(boundsFile, JSON.stringify(bounds));
    } catch (err) {
        console.error("Erro ao salvar bounds:", err);
    }
}

ipcMain.on("abrir-painel", () => {
    if (painelWindow && !painelWindow.isDestroyed()) {
        painelWindow.focus();
        return;
    }

    const bounds = loadBounds();

    painelWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width || 400,
        height: bounds.height || 600,
        frame: true,
        icon: path.join(__dirname, "njxlogo.png"),
        resizable: true,
        movable: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    painelWindow.loadURL("https://sempregreen.net.br/");

    painelWindow.webContents.on("before-input-event", (event, input) => {
        if ((input.control || input.meta) && ["I", "J", "C", "U"].includes(input.key.toUpperCase())) {
            event.preventDefault();
        }
    });
    painelWindow.webContents.on("context-menu", e => e.preventDefault());

    painelWindow.on("close", () => {
        saveBounds(painelWindow.getBounds());
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send("painel-status", false);
        });

        painelWindow = null;
    });

    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send("painel-status", true);
    });
});

ipcMain.on("fechar-painel", () => {
    if (painelWindow && !painelWindow.isDestroyed()) {
        painelWindow.close();
    }
});

/**
* @param {number} i
* @param {object} proxyConfig
* @param {object} device
* @param {{posX:number,posY:number,width:number,height:number}} [opts={}]
*/              
function createMobileContext(i, proxyConfig, device, opts = {}) {
    const { posX, posY, width, height } = opts;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `user-data-dir-${i}-`));

    const launchOpts = {
        executablePath: chromiumExecutablePath,
        userAgent: device.userAgent,
        locale: device.locale,
        screen: device.screen,
        proxy: proxyConfig,
        headless: false,
        ignoreHTTPSErrors: true,
        bypassCSP: true,
        viewport: null,
        userAgent: device.userAgent,
        hasTouch: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            `--window-position=${posX},${posY}`,
            `--window-size=${width},${height}`,
            '--disable-blink-features=AutomationControlled',
            "--disable-notifications",
            "--disable-save-password-bubble",
            "--disable-password-manager-reauthentication",
            '--force-device-scale-factor=0.6',
            '--disable-infobars',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=0',
            '--blink-settings=automationControlled=false',
            '--mute-audio'
        ]
    };

    return chromium
        .launchPersistentContext(userDataDir, launchOpts)
        .then(async context => {
            const page = await context.newPage();

            await page.addInitScript(MOBILE_INIT_SCRIPT);

            await page.evaluate(() => {
                window.isMobileMode = true;
                window.enableTouchTranslation = true;
            });

            return { context, page, isMobile: true };
        });
}

async function reiniciarAbas(params) {
    const { proxies = [], tabCount, mobileMode, urlToOpen } = params;
    lastParams = params;

    function montarProxyConfig(proxy) {
        if (!proxy) return undefined;
        const parts = proxy.split(':');
        if (parts.length < 4) return undefined;
        const [ip, port, username, password] = parts;
        return {
            server: `http://${ip}:${port}`,
            username,
            password
        };
    }


    if (mobileMode && tabCount > 0) {
        const posicoesSalvas = carregarPosicoes();

        {
            const proxy = proxies.length > 0 ? proxies[0 % proxies.length] : null;
            const proxyConfig = montarProxyConfig(proxy);
            const deviceName = mobileDevices[0 % mobileDevices.length];
            const device = devices[deviceName];

            const posSalva = posicoesSalvas.find(p => p.index === 0) || {};
            const linha = 0;
            const coluna = 0;
            const posX = posSalva.x ?? (ABA_OFFSET_LEFT + coluna * ABA_WIDTH);
            const posY = posSalva.y ?? (ABA_OFFSET_TOP + linha * ABA_HEIGHT);
            const width = posSalva.width ?? ABA_WIDTH;
            const height = posSalva.height ?? ABA_HEIGHT;

            const { context, page } = await createMobileContext(0, proxyConfig, device, { posX, posY, width, height });
            contexts.push({ context, page, isMobile: true });
            await page.goto(urlToOpen, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.evaluate(() => window.isMobileMode = true);
            if (proxyConfig) await addIpOverlay(page, proxy.split(':')[0]);
        }

        const promises = [];
        for (let i = 1; i < tabCount; i++) {
            const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
            const proxyConfig = montarProxyConfig(proxy);
            const deviceName = mobileDevices[i % mobileDevices.length];
            const device = devices[deviceName];

            const posSalva = posicoesSalvas.find(p => p.index === i) || {};
            const linha = Math.floor(i / ABAS_POR_LINHA);
            const coluna = i % ABAS_POR_LINHA;
            const posX = posSalva.x ?? (ABA_OFFSET_LEFT + coluna * ABA_WIDTH);
            const posY = posSalva.y ?? (ABA_OFFSET_TOP + linha * ABA_HEIGHT);
            const width = posSalva.width ?? ABA_WIDTH;
            const height = posSalva.height ?? ABA_HEIGHT;

            promises.push((async () => {
                const { context, page } = await createMobileContext(i, proxyConfig, device, { posX, posY, width, height });
                await page.goto(urlToOpen, { waitUntil: 'domcontentloaded', timeout: 30000 });
                if (proxyConfig) await addIpOverlay(page, proxy.split(':')[0]);
                await page.evaluate(() => window.isMobileMode = true);
                contexts.push({ context, page, isMobile: true });
            })());
        }

        await Promise.all(promises);
    
    } else {
        const promises = [];

        {
            const proxy = proxies.length > 0 ? proxies[0 % proxies.length] : null;
            const proxyConfig = montarProxyConfig(proxy);

            const posicoesSalvas = carregarPosicoes();
            const posSalva = posicoesSalvas.find(p => p.index === 0);

            const linha = 0;
            const coluna = 0;
            const posX = posSalva?.x ?? ABA_OFFSET_LEFT + coluna * ABA_WIDTH;
            const posY = posSalva?.y ?? ABA_OFFSET_TOP + linha * ABA_HEIGHT;
            const width = posSalva?.width ?? ABA_WIDTH;
            const height = posSalva?.height ?? ABA_HEIGHT;

            const context = await chromium.launchPersistentContext(
                fs.mkdtempSync(path.join(os.tmpdir(), `user-data-dir-0-`)),
                {
                    executablePath: chromiumExecutablePath,
                    proxy: proxyConfig,
                    headless: false,
                    ignoreHTTPSErrors: true,
                    bypassCSP: true,
                    viewport: null,
                    ignoreDefaultArgs: ['--enable-automation'],
                    args: [
                        `--window-position=${posX},${posY}`,
                        `--window-size=${width},${height}`,
                        '--disable-blink-features=AutomationControlled',
                        "--disable-notifications",
                        "--disable-save-password-bubble",
                        "--disable-password-manager-reauthentication",
                        '--force-device-scale-factor=0.6',
                        '--disable-infobars',
                        '--no-sandbox',
                        '--disable-dev-shm-usage',
                        '--remote-debugging-port=0',
                        '--blink-settings=automationControlled=false',
                        '--mute-audio'
                    ],
                }
            );

            const page = await context.newPage();
            await page.goto(urlToOpen, { timeout: 30000, waitUntil: 'domcontentloaded' });
            if (proxyConfig) await addIpOverlay(page, proxy.split(':')[0]);

            contexts.push({ context, page, isMobile: false });
        }

        for (let i = 1; i < tabCount; i++) {
            const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
            const proxyConfig = montarProxyConfig(proxy);

            const posicoesSalvas = carregarPosicoes();
            const posSalva = posicoesSalvas.find(p => p.index === i);

            const linha = Math.floor(i / ABAS_POR_LINHA);
            const coluna = i % ABAS_POR_LINHA;
            const posX = posSalva?.x ?? ABA_OFFSET_LEFT + coluna * ABA_WIDTH;
            const posY = posSalva?.y ?? ABA_OFFSET_TOP + linha * ABA_HEIGHT;
            const width = posSalva?.width ?? ABA_WIDTH;
            const height = posSalva?.height ?? ABA_HEIGHT;

            promises.push((async () => {
                const context = await chromium.launchPersistentContext(
                    fs.mkdtempSync(path.join(os.tmpdir(), `user-data-dir-${i}-`)),
                    {
                        executablePath: chromiumExecutablePath,
                        proxy: proxyConfig,
                        headless: false,
                        ignoreHTTPSErrors: true,
                        bypassCSP: true,
                        viewport: null,
                        ignoreDefaultArgs: ['--enable-automation'],
                        args: [
                            `--window-position=${posX},${posY}`,
                            `--window-size=${width},${height}`,
                            '--disable-blink-features=AutomationControlled',
                            "--disable-notifications",
                            "--disable-save-password-bubble",
                            '--force-device-scale-factor=0.6',
                            "--disable-password-manager-reauthentication",
                            '--disable-infobars',
                            '--no-sandbox',
                            '--disable-dev-shm-usage',
                            '--remote-debugging-port=0',
                            '--blink-settings=automationControlled=false',
                            '--mute-audio'
                        ],
                    }
                );

                const page = await context.newPage();
                await page.goto(urlToOpen, { timeout: 30000, waitUntil: 'domcontentloaded' });
                if (proxyConfig) await addIpOverlay(page, proxy.split(':')[0]);

                contexts.push({ context, page, isMobile: false });
            })());
        }

        await Promise.all(promises);

        if (mirrorMode && contexts.length > 0) {
            // expõe uma função global na aba 0 que o script injetado chamará
            await contexts[0].page.exposeFunction('_sendMirrorExposed', action => {
                // envia pelo canal que já existe no top do main: 'mirror-event'
                ipcMain.emit('mirror-event', null, action);
            });

            // Script injetado na aba fonte (index 0) para capturar clicks, teclado, input e scroll.
            // Observações:
            // - throttle para scroll: 30ms (ajustável)
            // - envia selector quando possível; também envia ratios de posição (ratioX/ratioY)
            const MIRROR_CAPTURE = `
      (function() {
        if (window.__mirrorCaptureInstalled) return;
        window.__mirrorCaptureInstalled = true;

        function safeSend(obj) {
          try {
            if (window._sendMirrorExposed) {
              window._sendMirrorExposed(obj);
            }
          } catch (e) { /* ignore */ }
        }

        // simple throttle
        function throttle(fn, wait) {
          let last = 0;
          return function(...args) {
            const now = Date.now();
            if (now - last >= wait) {
              last = now;
              fn.apply(this, args);
            }
          };
        }

        function getSimpleSelector(el) {
          try {
            if (!el) return null;
            if (el.id) return '#' + el.id;
            if (el === document.body) return 'body';
            const parts = [];
            while (el && el.nodeType === 1 && el !== document.body) {
              let part = el.tagName.toLowerCase();
              if (el.className) {
                const cls = String(el.className).split(' ').filter(Boolean)[0];
                if (cls) part += '.' + cls.replace(/\\s+/g,'');
              }
              const parent = el.parentNode;
              if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                if (siblings.length > 1) {
                  const idx = Array.prototype.indexOf.call(parent.children, el) + 1;
                  part += ':nth-child(' + idx + ')';
                }
              }
              parts.unshift(part);
              el = el.parentNode;
            }
            return parts.join(' > ');
          } catch (e) { return null; }
        }

        document.addEventListener('click', function(e) {
          try {
            const sel = getSimpleSelector(e.target);
            const ratioX = e.clientX / (window.innerWidth || 1);
            const ratioY = e.clientY / (window.innerHeight || 1);
            safeSend({
              type: 'click',
              selector: sel,
              ratioX,
              ratioY,
              button: e.button,
              ctrl: e.ctrlKey,
              meta: e.metaKey,
              shift: e.shiftKey
            });
          } catch (e) {}
        }, true);

        document.addEventListener('input', function(e) {
          try {
            const sel = getSimpleSelector(e.target);
            if (!sel) return;
            safeSend({ type: 'input', selector: sel, value: e.target.value });
          } catch (e) {}
        }, true);

        document.addEventListener('keydown', function(e) {
          try {
            safeSend({
              type: 'key',
              key: e.key,
              code: e.code,
              ctrl: e.ctrlKey,
              meta: e.metaKey,
              shift: e.shiftKey,
              alt: e.altKey
            });
          } catch (e) {}
        }, true);

        // throttle scroll events
        const onScroll = throttle(function() {
          try {
            safeSend({
              type: 'scroll',
              ratioX: (window.scrollX || 0) / (document.documentElement.scrollWidth || window.innerWidth || 1),
              ratioY: (window.scrollY || 0) / (document.documentElement.scrollHeight || window.innerHeight || 1)
            });
          } catch (e) {}
        }, 30);
        window.addEventListener('scroll', onScroll, true);

        // capture paste via paste event
        document.addEventListener('paste', function(e) {
          try {
            const sel = getSimpleSelector(e.target);
            const clipboard = (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text')) || null;
            safeSend({ type: 'paste', selector: sel, clipboard, ctrl: e.ctrlKey, meta: e.metaKey });
          } catch (e) {}
        }, true);
      })();
    `;

            // inject script on the page so it's available at runtime and after navigations
            await contexts[0].page.addInitScript({ content: MIRROR_CAPTURE });
            // also evaluate immediately in case page already loaded
            try { await contexts[0].page.evaluate(MIRROR_CAPTURE); } catch (e) { /* ignore */ }
        }
    }
}
ipcMain.on('abrir-link-externo', (event, url) => {
    shell.openExternal(url);
});

async function getFrameComCampos(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const inputs = await frame.$$('input, textarea');
            if (inputs.length >= 3) return frame;
        } catch { }
    }
    return page;
}

async function detectarCampos(frame) {
    const mapa = {};
    const detectores = {
        usuario: /\b(usu[aá]rio|login|user(name)|conta?)\b/i,
        nome: /\b(nome(?!.*usu[aá]rio))\b/i, // evita "nome de usuário"
        senha: /\b(senha|password)\b/i,
        confirmarSenha: /\b(confirmar|repetir|repita|confirme)\b/i,
        telefone: /\b(telefone|celular|contato)\b/i,
        cpf: /\bcpf\b/i,
    };

    const campos = await frame.$$('input, textarea');

    for (const campo of campos) {
        const attrs = [
            await campo.getAttribute('name'),
            await campo.getAttribute('id'),
            await campo.getAttribute('placeholder'),
            await campo.getAttribute('aria-label'),
            ...(await campo.evaluate(el => {
                const label = document.querySelector(`label[for='${el.id}']`);
                return label ? [label.innerText] : [];
            }))
        ].filter(Boolean).map(a => a.toLowerCase());

        for (const [chave, regex] of Object.entries(detectores)) {
            if (attrs.some(a => regex.test(a)) && !mapa[chave]) {
                mapa[chave] = campo;
                break;
            }
        }
    }

    return mapa;
}

ipcMain.handle('close-all', async () => {
    try {
        const closePromises = [];

        // Fecha todas as abas Playwright
        for (const { context } of contexts) {
            if (context && context.close) {
                try {
                    closePromises.push(context.close());
                } catch (e) {
                    console.warn('Erro ao fechar contexto:', e.message);
                }
            }
        }

        // Força encerramento de qualquer navegador desktop também
        if (browserDesktop) {
            try {
                closePromises.push(browserDesktop.close());
            } catch (e) {
                console.warn('Erro ao fechar browserDesktop:', e.message);
            }
            browserDesktop = null;
        }

        // Aguarda todas fecharem
        await Promise.allSettled(closePromises);
        contexts = [];

        // Força coleta de lixo e limpeza de diretórios temporários, se desejar
        // opcional: limpa diretórios temporários se você quiser
        // fs.rmSync(storageStatesDir, { recursive: true, force: true });

        // Notifica UI
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('proxies-status', { enabled: true });
        });

        return { success: true };
    } catch (err) {
        console.error('Erro ao fechar abas:', err);
        return { success: false, error: err.message };
    }
});

function salvarContas(contas) {
    try {
        fs.writeFileSync(contasFilePath, JSON.stringify(contas, null, 2), 'utf-8');
    } catch (err) {
        console.error('Erro ao salvar contas:', err);
    }
}
function removerAcentos(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function gerarSenhaPadrao() {
    const numeros = faker.string.numeric(4);
    const letras = faker.string.alpha(5).toLowerCase();
    return letras + numeros;
}
function gerarTelefoneBrasileiro() {
    const ddds = [
        '11', '21', '31', '41', '51', '61', '71', '81', '91', '92', '47', '67', '62', '48', '98', '95', '69', '82', '84',
        '86', '96', '53', '83', '94', '85', '63', '79', '89', '66', '93', '88', '97', '46', '65', '73', '75', '64', '74',
        '68', '43', '42', '45', '44', '34', '35', '32', '33', '38', '37', '27', '28', '24', '22', '19', '18', '16', '15',
        '14', '13', '12'
    ];
    const ddd = ddds[Math.floor(Math.random() * ddds.length)];
    const numero = '9' + faker.string.numeric(8);
    return ddd + numero;
}

// Handler para criar contas preenchendo campos detectados
ipcMain.handle('create-accounts', async () => {
    const resultados = await Promise.all(
        contexts.map(async ({ page }) => {
            const frame = await getFrameComCampos(page);
            const campos = await detectarCampos(frame); // Detectar primeiro

            // Gerar apenas os dados necessários com base nos campos detectados
            const dados = {};
            if (campos.nome) {
                const nome = removerAcentos(faker.person.fullName());
                dados.nome = nome;
            }
            if (campos.usuario) {
                const primeiraLetra = faker.string.alpha({ length: 1, casing: 'upper' });
                const letras = faker.string.alpha({ length: 4, casing: 'lower' });
                const numeros = faker.string.numeric(4);
                dados.usuario = primeiraLetra + letras + numeros;
            }
            if (campos.senha) {
                dados.senha = gerarSenhaPadrao();
            }
            if (campos.confirmarSenha) {
                dados.confirmarSenha = dados.senha; // mesma senha
            }
            if (campos.telefone) {
                dados.telefone = gerarTelefoneBrasileiro();
            }
            if (campos.cpf) {
                dados.cpf = obterCpfValido() || faker.string.numeric(11);
            }

            try {
                // Preencher os campos na ordem de detecção
                for (const [chave, campo] of Object.entries(campos)) {
                    if (!campo || !dados[chave]) continue;
                    await campo.click({ timeout: 2000 });
                    await campo.fill(dados[chave]);
                }

                // Tentar encontrar botão de envio
                const botoes = await frame.$$('button, input[type="submit"]');

                const botaoConfirmar = await Promise.any(
                    botoes.map(async (botao) => {
                        const texto = ((await botao.innerText?.()) || '').toLowerCase();
                        if (
                            texto.includes('confirmar') ||
                            texto.includes('enviar') ||
                            texto.includes('cadastrar') ||
                            texto.includes('registrar') ||
                            texto.includes('criar conta') ||
                            texto.includes('submit') ||
                            texto.includes('registro') ||
                            texto.includes('cadastrar-se') ||
                            texto.includes('cadastro') ||
                            texto.includes('realizar cadastro') ||
                            texto.includes('registrar-se')
                        ) return botao;
                        throw new Error('não é botão de confirmar');
                    })
                ).catch(() => null);

                if (botaoConfirmar) {
                    await botaoConfirmar.click();
                }

                return dados;
            } catch (err) {
                return { erro: err.message };
            }
        })
    );

    return resultados;
});

// Função para carregar contas salvas do arquivo JSON
function carregarContasSalvas() {
    try {
        if (fs.existsSync(contasFilePath)) {
            const data = fs.readFileSync(contasFilePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Erro ao carregar contas salvas:', err);
    }
    return [];
}

// Novo handler para carregar contas salvas via IPC
ipcMain.handle('carregar-contas-salvas', () => {
    // Retorna as contas já carregadas em memória, ou do arquivo caso não tenha
    if (contasCriadasPersistentes.length > 0) return contasCriadasPersistentes;
    return carregarContasSalvas();
});

ipcMain.handle('atualizar-cpfs', (event, cpfsTexto) => {
    cpfsDisponiveis = cpfsTexto
        .split('\n')
        .map(c => limparCPF(c))
        .filter(c => /^\d{11}$/.test(c));
    return cpfsDisponiveis.length;
});

app.whenReady().then(() => {
    createWindow();
    ipcMain.on('start-proxies', async (event, params) => {
        try {
            mirrorMode = params.mirrorMode ?? false;
            await reiniciarAbas(params);
            const novasProxies = params.proxies.slice(params.tabCount); // remove as proxies usadas
            event.sender.send('atualizar-proxies-interface', novasProxies);
            proxiesReady = true;
            event.sender.send('start-proxies-done', { success: true, opened: contexts.length, mirrorMode });
            event.sender.send('proxies-status', { enabled: false });
        } catch (err) {
            console.error('ERRO:', err);
            event.sender.send('start-proxies-done', { success: false, error: err.message });
        }
    });
    ipcMain.on('refresh-pages', async (event) => {
        if (contexts.length === 0) {
            event.sender.send('refresh-pages-done', {
                success: false,
                error: 'Nenhuma aba aberta.'
            });
            return;
        }

        try {
            await Promise.all(
                contexts.map(({ page }) =>
                    page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
                )
            );

            event.sender.send('refresh-pages-done', { success: true });
        } catch (err) {
            console.error('Erro ao atualizar páginas:', err);
            event.sender.send('refresh-pages-done', {
                success: false,
                error: err.message
            });
        }
    });
    ipcMain.on('disable-mirror', async () => {
        await desativarEspelhamento();
    });
});
ipcMain.on('login-red', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
        win.setBounds({ width: 400, height: 500, x: 100, y: 100});
        win.center();
        win.loadFile('login.html');
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

    app.on('window-all-closed', () => {
        app.quit();
    });