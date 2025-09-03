// posicoesManager.js
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const posicoesPath = path.join(app.getPath('userData'), 'posicoes-abas.json');

/**
 * Salva posição e tamanho de cada aba/page.
 * @param {Array<{ context: any, page: import('playwright').Page }>} contexts
 */
async function salvarPosicoes(contexts) {
    console.log('[posicoes] salvando posições de', contexts.length, 'abas');
    const posicoes = [];

    for (let i = 0; i < contexts.length; i++) {
        const { page } = contexts[i];
        try {
            // executa no contexto da página para obter posição e tamanho reais
            const info = await page.evaluate(() => ({
                x: window.screenX,
                y: window.screenY,
                width: window.outerWidth,
                height: window.outerHeight
            }));

            posicoes.push({
                index: i,
                x: info.x,
                y: info.y,
                width: info.width,
                height: info.height
            });
        } catch (err) {
            console.warn(`[posicoes] erro ao capturar posição/size da aba ${i}:`, err.message);
        }
    }

    // grava o JSON
    try {
        fs.writeFileSync(posicoesPath, JSON.stringify(posicoes, null, 2), 'utf-8');
        console.log('[posicoes] posições gravadas:', posicoesPath);
        console.log('[posicoes]', posicoes);
    } catch (err) {
        console.error('[posicoes] erro ao escrever arquivo:', err);
        throw err;
    }
}
function carregarPosicoes() {
    if (!fs.existsSync(posicoesPath)) {
        return [];
    }
    try {
        const data = fs.readFileSync(posicoesPath, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.warn('[posicoes] erro ao carregar posições:', err.message);
        return [];
    }
}
function resetarPosicoesParaPadrao() {
    const posicoesPath = path.join(app.getPath('userData'), 'posicoes-abas.json');
    try {
        if (fs.existsSync(posicoesPath)) {
            fs.unlinkSync(posicoesPath);
            console.log('Posições resetadas para o padrão (arquivo removido).');
        } else {
            console.log('Nenhum arquivo de posições encontrado para resetar.');
        }
    } catch (err) {
        console.error('Erro ao resetar posições:', err);
        throw err;
    }
}

module.exports = {
    salvarPosicoes,
    carregarPosicoes,
    resetarPosicoesParaPadrao
};
