const { contextBridge, ipcRenderer, shell, ipcMain } = require('electron');
const os = require('os');


const args = process.argv;
console.log("🔍 process.argv:", args);
let API_URL = 'https://server-production-0a24.up.railway.app';
let CLIENT_VERSION = '';
let OFFLINE_LOGIN = false;

for (const arg of process.argv) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--apiUrl=')) {
        API_URL = arg.split('--apiUrl=')[1] || '';
    } else if (arg.startsWith('--clientVersion=')) {
        CLIENT_VERSION = arg.split('--clientVersion=')[1] || '';
    } else if (arg.startsWith('--offlineLogin=')) {
        const v = arg.split('--offlineLogin=')[1] || '';
        OFFLINE_LOGIN = (String(v).toLowerCase() === 'true' || String(v) === '1');
    }
}


contextBridge.exposeInMainWorld('nconfig', {
    API_URL,
    CLIENT_VERSION,
    OFFLINE_LOGIN
});
contextBridge.exposeInMainWorld('config', {
    API_URL: 'https://server-production-0a24.up.railway.app'
});
contextBridge.exposeInMainWorld('abrirLinkExterno', {
    abrir: (url) => shell.openExternal(url)
});

console.log("✅ API_URL carregada do argumento:", API_URL);
console.log("✅ OFFLINE_LOGIN:", OFFLINE_LOGIN);

function getMacAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                return iface.mac;
            }
        }
    }
    return null;
}
contextBridge.exposeInMainWorld('electronAPI', {
    enviarLoginSucesso: (dados) => {
        console.log('[preload] enviando login-sucesso', dados);
        ipcRenderer.send('login-sucesso', dados);
    },
    getMac: () => getMacAddress(),
    send: (channel, data) => {
        const validChannels = ['start-proxies', 'open-new-tab', 'refresh-pages', 'login-sucesso', 'disable-mirror', 'abrir-link-externo', 'login-red', 'abrir-painel', 'fechar-painel', 'painel-fechado', 'criar-pagamento-pix'];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    onLogoutForcado: (callback) => ipcRenderer.on('logout-forcado', callback),

    on: (channel, func) => {
        const validChannels = [
            'start-proxies-done',
            'refresh-pages-done',
            'atualizar-proxies-interface',
            'mirror-status',
            'mirror-action',
            'abrir-link-externo',
            'atualizar-proxies-interface'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
        }
    },

    invoke: (channel, data) => {
        const validChannels = [
            'salvar-posicoes-abas',
            'resetar-posicoes',
            'close-all',
            'create-accounts',
            'carregar-contas-salvas',
            'atualizar-cpfs',
            'getSystemUsage',
            'executar-otimizacoes',
            'executar-tarefa-individual',
            'toggle-touch-translation',
            'criar-pagamento-pix',
            'verificar-pagamento',
            'toggle-mirror',
            'obter-produto',      
            'baixar-produto',
            'obter-proxies',     
            'salvar-proxies-txt'
        ];
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error('Canal IPC inválido'));
    },
    toggleMirror: (enable) => ipcRenderer.invoke('toggle-mirror', enable),
    setTouchMode: (flag) => ipcRenderer.send('mirror-set-touch', flag)
});

contextBridge.exposeInMainWorld('tabsAPI', {
    save: () => ipcRenderer.invoke('salvar-posicoes-abas'),
    reset: () => ipcRenderer.invoke('resetar-posicoes')
});

ipcRenderer.on('atualizar-proxies-interface', (event, novasProxies) => {
    window.dispatchEvent(new CustomEvent('atualizarProxiesCampo', { detail: novasProxies }));
});

contextBridge.exposeInMainWorld('authChecker', {
    iniciar: (usuario) => {
        setInterval(() => {
            fetch(`${window.config.API_URL}/verificar-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario })
            })
                .then(res => res.json())
                .then(data => {
                    if (!data.valido) {
                        window.location.href = 'login.html';
                    }
                })
                .catch(err => console.error('Erro ao verificar usuário:', err));
        }, 5000);
    }
});

contextBridge.exposeInMainWorld('config', {
    get API_URL() {
        return API_URL;
    }
});
