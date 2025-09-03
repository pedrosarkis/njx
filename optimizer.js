// main/optimizer.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function executarComando(comando) {
    return new Promise((resolve, reject) => {
        const processo = spawn('cmd.exe', ['/c', comando], { windowsHide: true });

        processo.stdout.on('data', (data) => {
            console.log(`[stdout] ${data}`);
        });

        processo.stderr.on('data', (data) => {
            console.error(`[stderr] ${data}`);
        });

        processo.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Erro ao executar: ${comando}, código: ${code}`));
            }
        });
    });
}

function executarOtimizacoes(tarefas) {
    const comandos = [];

    if (tarefas.includes('limpar-temp')) {
        comandos.push(`del /q /s %TEMP%\\*`);
        comandos.push(`del /q /s C:\\Windows\\Temp\\*`);
    }

    if (tarefas.includes('limpar-dns')) {
        comandos.push(`ipconfig /flushdns`);
    }

    if (tarefas.includes('liberar-ram')) {
        comandos.push(`echo RamCleaner > nul`); // Simula — pode ser substituído por algo real
    }

    if (tarefas.includes('desfragmentar')) {
        comandos.push(`defrag C: /U /V`);
    }

    if (tarefas.includes('modo-alto-desempenho')) {
        comandos.push(`powercfg -setactive SCHEME_MIN`);
    }

    if (tarefas.includes('verificar-sfc')) {
        comandos.push(`sfc /scannow`);
    }

    if (tarefas.includes('limpar-prefetch')) {
        comandos.push(`del /q /s C:\\Windows\\Prefetch\\*`);
    }

    return new Promise((resolve, reject) => {
        let i = 0;
        const executarProximo = () => {
            if (i >= comandos.length) return resolve();
            const comando = comandos[i++];
            executarComando(comando)
                .then(() => executarProximo())
                .catch((err) => {
                    console.error(`❌ Erro ao executar: ${comando}`, err);
                    executarProximo(); // continua mesmo com erro
                });
        };
        executarProximo();
    });
}

module.exports = { executarOtimizacoes };