// login.js — arquivo completo
// Fluxo:
// 1) Ao clicar em "Login" faz POST /login (envia versao_cliente).
// 2) Se receber token, verifica /versao (ou usa loginData.versao_ok se backend já retornou).
// 3) Se versão OK -> salva token + envia evento para o main (enviarLoginSucesso).
// 4) Se versão não OK -> redireciona para desatualizado.html.
// 5) Mostra overlay "Carregando..." enquanto as requisições estão em andamento.

// Política: quando /versao falhar, abrir o launcher (true) ou bloquear (false)
const PERMIT_ON_VERSION_CHECK_FAILURE = true; // ajuste conforme sua política

// --- Overlay de loading (simples, cobre toda a tela) ---
function showLoadingOverlay(text = 'Carregando...') {
    if (document.getElementById('app-loading-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'app-loading-overlay';
    Object.assign(ov.style, {
        position: 'fixed',
        inset: '0',
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        color: '#fff',
        fontSize: '16px',
        fontFamily: 'Arial, sans-serif',
        userSelect: 'none'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        padding: '18px',
        borderRadius: '8px'
    });

    const spinner = document.createElement('div');
    spinner.className = 'overlay-spinner';
    Object.assign(spinner.style, {
        width: '56px',
        height: '56px',
        border: '6px solid rgba(255,255,255,0.15)',
        borderTop: '6px solid white',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite'
    });

    const label = document.createElement('div');
    label.innerText = text;
    Object.assign(label.style, { color: '#fff', opacity: 0.95 });

    // injeta keyframes apenas uma vez
    if (!document.getElementById('overlay-spinner-styles')) {
        const s = document.createElement('style');
        s.id = 'overlay-spinner-styles';
        s.innerHTML = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
        document.head.appendChild(s);
    }

    box.appendChild(spinner);
    box.appendChild(label);
    ov.appendChild(box);
    document.body.appendChild(ov);
}

function removeLoadingOverlay() {
    const ov = document.getElementById('app-loading-overlay');
    if (ov) ov.remove();
}

// --- Função auxiliar para exibir mensagens simples (alert fallback) ---
function showMessage(msg) {
    try { alert(msg); } catch (_) { console.log(msg); }
}

// --- Principal: listener do DOM e handler do botão ---
document.addEventListener('DOMContentLoaded', () => {
    const usuarioInput = document.getElementById('usuario');
    const senhaInput = document.getElementById('senha');
    const keyInput = document.getElementById('key'); // se existir
    const loginBtn = document.getElementById('loginBtn');

    if (!loginBtn) {
        console.error('[login.js] botão de login não encontrado (id="loginBtn")');
        return;
    }

    // lê configuração exposta pelo preload.js
    const API_URL = window.config && window.config.API_URL;
    const CLIENT_VERSION = (window.config && window.config.CLIENT_VERSION) || '';

    if (!API_URL) {
        console.error('[login.js] API_URL não encontrado em window.config');
        showMessage('Erro de configuração: API_URL não definido.');
        return;
    }

    loginBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        const usuario = (usuarioInput && usuarioInput.value || '').trim();
        const senha = (senhaInput && senhaInput.value || '').trim();
        const key = (keyInput && keyInput.value || '').trim();

        if (!usuario || !senha) {
            showMessage('Por favor preencha usuário e senha.');
            return;
        }

        // UI: desativa botão e mostra overlay
        loginBtn.disabled = true;
        const oldText = loginBtn.innerText;
        try { loginBtn.innerText = 'Entrando...'; } catch (_) { }

        showLoadingOverlay('Entrando...');

        try {
            // 1) Faz o login e envia versao_cliente no body
            const loginResp = await fetch(`${API_URL.replace(/\/$/, '')}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario, senha, key, versao_cliente: CLIENT_VERSION })
            });

            let loginData = {};
            try { loginData = await loginResp.json(); } catch (_) { loginData = {}; }

            if (!loginResp.ok || !loginData.token) {
                // backend já pode ter retornado versao_ok:false sem token
                if (loginData.versao_ok === false) {
                    removeLoadingOverlay();
                    showMessage('Versão do cliente desatualizada. Você será redirecionado para atualização.');
                    window.location.href = 'desatualizado.html';
                    return;
                }
                // outros erros (credenciais, etc.)
                const msg = loginData.erro || `Erro no login (status ${loginResp.status}).`;
                removeLoadingOverlay();
                showMessage(msg);
                return;
            }

            // 2) Token recebido — agora verificar versão do servidor se necessário
            let versaoOk = false;
            let versaoAtual = null;

            // Caso o backend já tenha retornado versao_ok/versao_atual, use isso para evitar segunda chamada
            if (typeof loginData.versao_ok !== 'undefined') {
                versaoOk = !!loginData.versao_ok;
                versaoAtual = loginData.versao_atual || null;
                console.log('[login.js] versão fornecida no /login:', { versaoAtual, versaoOk });
            } else {
                // senão, consulta /versao
                try {
                    const vRes = await fetch(`${API_URL.replace(/\/$/, '')}/versao`, { method: 'GET', headers: { Accept: 'application/json' } });
                    if (!vRes.ok) throw new Error(`HTTP ${vRes.status}`);
                    const vJson = await vRes.json();
                    versaoAtual = vJson.versao_atual || vJson.versao || null;

                    if (versaoAtual) {
                        const normalize = s => String(s || '').trim();
                        versaoOk = normalize(versaoAtual) === normalize(CLIENT_VERSION);
                    } else {
                        console.warn('[login.js] /versao respondeu sem versao_atual:', vJson);
                        versaoOk = PERMIT_ON_VERSION_CHECK_FAILURE;
                    }
                } catch (verr) {
                    console.error('[login.js] erro ao consultar /versao:', verr);
                    versaoOk = PERMIT_ON_VERSION_CHECK_FAILURE;
                }
            }

            console.log(`[login.js] Versão cliente: ${CLIENT_VERSION} | Versão server: ${versaoAtual} | versaoOk: ${versaoOk}`);

            if (!versaoOk) {
                removeLoadingOverlay();
                showMessage('Versão do cliente inválida ou desatualizada. Você será redirecionado para a atualização.');
                window.location.href = 'desatualizado.html';
                return;
            }

            // 3) Tudo OK: salva token localmente e envia evento para o main
            try {
                window.localStorage.setItem('token', loginData.token);
            } catch (e) {
                console.warn('[login.js] falha ao salvar token no localStorage:', e);
            }

            const dadosParaMain = { usuario, token: loginData.token, versao_ok: true, versao_atual: versaoAtual };

            // Mantemos o overlay até a nova página carregar — a troca de página removerá o DOM,
            // então não há necessidade de remover explicitamente aqui.
            try {
                if (window.electronAPI && typeof window.electronAPI.enviarLoginSucesso === 'function') {
                    // opcional: dar um pequeno delay para o overlay aparecer visualmente antes de trocar
                    // await new Promise(r => setTimeout(r, 120));
                    window.electronAPI.enviarLoginSucesso(dadosParaMain);
                } else {
                    // fallback: se não houver main, abre localmente
                    window.location.href = 'launcher.html';
                }
            } catch (e) {
                console.error('[login.js] erro ao enviar evento para main:', e);
                // fallback local
                removeLoadingOverlay();
                window.location.href = 'launcher.html';
            }

        } catch (err) {
            console.error('[login.js] erro no fluxo de login/verificacao:', err);
            removeLoadingOverlay();
            showMessage('Erro de conexão com o servidor. Tente novamente.');
        } finally {
            // reativa botão (se a página for trocada, isso é irrelevante)
            try {
                loginBtn.disabled = false;
                loginBtn.innerText = oldText;
            } catch (_) { }
        }
    });
});
