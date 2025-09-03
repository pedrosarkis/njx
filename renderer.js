const urlInput = document.getElementById('url');
const tabCountInput = document.getElementById('tabCount');
const proxyListInput = document.getElementById('proxyList');
const mobileModeSelect = document.getElementById('mobileMode');
const btnStart = document.getElementById('btnStart');
const btnToggleMirror = document.getElementById('btnToggleMirror');
const btnCloseAll = document.getElementById('btnCloseAll');
const statusDiv = document.getElementById('status');
const mirrorStatusDiv = document.getElementById('mirror-status');
const ipDisplayDiv = document.getElementById('ip-display');
const { ipcRenderer } = require('electron');

let mirrorActive = false;

function atualizarEstadoProxy(habilitar) {
    proxyListInput.disabled = !habilitar;
}

btnStart.addEventListener('click', () => {
    const url = urlInput.value.trim();
    const tabCount = parseInt(tabCountInput.value, 10) || 1;
    const proxyLines = proxyListInput.value.trim().split('\n').filter(Boolean);
    const mobileMode = mobileModeSelect.value === 'true';

    if (!url) {
        alert('Informe uma URL válida.');
        return;
    }
    if (tabCount < 1 || tabCount > 100) {
        alert('Número de abas deve ser entre 1 e 100.');
        return;
    }
    // Se quiser permitir proxy opcional, comente essa validação
    if (proxyLines.length === 0) {
        alert('Informe pelo menos um proxy.');
        return;
    }

    btnStart.disabled = true;
    btnToggleMirror.disabled = true;
    btnCloseAll.disabled = true;
    statusDiv.textContent = 'Abrindo abas...';

    atualizarEstadoProxy(false);

    window.electronAPI.startProxies({
        urlToOpen: url,
        tabCount,
        proxies: proxyLines,
        mobileMode,
        mirrorMode: mirrorActive,
    });
});

window.electronAPI.onStartProxiesDone((data) => {
    btnStart.disabled = false;
    btnCloseAll.disabled = false;
    if (data.success) {
        statusDiv.textContent = `Abas abertas: ${data.opened}`;
        btnToggleMirror.disabled = false;
        mirrorActive = data.mirrorMode;
        atualizarStatusEspelhamento(mirrorActive);
        ipDisplayDiv.style.display = 'block';
        ipDisplayDiv.textContent = '';
        atualizarEstadoProxy(false);
    } else {
        statusDiv.textContent = 'Erro: ' + data.error;
        atualizarEstadoProxy(true);
    }
});


btnToggleMirror.addEventListener('click', async () => {
    btnToggleMirror.disabled = true;
    const ativar = !mirrorActive;
    const resultado = await window.electronAPI.toggleMirror(ativar);
    if (resultado.success) {
        mirrorActive = ativar;
        atualizarStatusEspelhamento(mirrorActive);
        statusDiv.textContent = mirrorActive ? 'Espelhamento ativado' : 'Espelhamento desativado';
    } else {
        statusDiv.textContent = 'Falha ao alternar espelhamento: ' + (resultado.error || 'erro desconhecido');
    }
    btnToggleMirror.disabled = false;
});

window.electronAPI.onMirrorStatus((data) => {
    mirrorActive = data.active;
    atualizarStatusEspelhamento(mirrorActive);
});

btnCloseAll.addEventListener('click', async () => {
    btnStart.disabled = true;
    btnToggleMirror.disabled = true;
    btnCloseAll.disabled = true;
    statusDiv.textContent = 'Fechando todas as abas...';
    const res = await window.electronAPI.closeAll();
    if (res.success) {
        statusDiv.textContent = 'Todas as abas fechadas.';
        mirrorActive = false;
        atualizarStatusEspelhamento(false);
        ipDisplayDiv.style.display = 'none';
        atualizarEstadoProxy(true);
    } else {
        statusDiv.textContent = 'Erro ao fechar abas: ' + res.error;
        atualizarEstadoProxy(false);
    }
    btnStart.disabled = false;
});

function atualizarStatusEspelhamento(ativo) {
    if (ativo) {
        mirrorStatusDiv.style.display = 'block';
        mirrorStatusDiv.classList.remove('inactive');
        mirrorStatusDiv.classList.add('active');
    } else {
        mirrorStatusDiv.style.display = 'block';
        mirrorStatusDiv.classList.remove('active');
        mirrorStatusDiv.classList.add('inactive');
    }
}

atualizarEstadoProxy(true);
