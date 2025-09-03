class MirrorController {
    constructor(getContexts) {
        this.getContexts = getContexts;
        this.enabled = false;
    }

    toggle(force) {
        this.enabled = (typeof force === 'boolean') ? force : !this.enabled;
        console.log('[MirrorController] toggle ->', this.enabled);
        return this.enabled;
    }

    async handleEvent(ev) {
        if (!this.enabled) return;

        const contexts = this.getContexts();
        if (!contexts || contexts.length <= 1) return;

        const targets = contexts.slice(1);
        // debug leve
        // console.log(`[MirrorController] ${ev.type} -> ${targets.length} abas`);

        for (const ctx of targets) {
            const page = ctx.page;
            try {
                switch (ev.type) {
                    case 'click': await this._replicateClick(page, ev); break;
                    case 'key': await this._replicateKey(page, ev); break;
                    case 'wheel': await this._replicateWheel(page, ev); break;   // novo
                    case 'scroll': await this._replicateScroll(page, ev); break;  // fallback
                }
            } catch (e) {
                console.error(`[MirrorController] erro replicando ${ev.type}:`, e);
            }
        }
    }

    // -------------- ações “brutas” --------------

    async _replicateClick(page, ev) {
        // pega tamanho real da janela (viewportSize pode ser null)
        const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        const x = Math.round(ev.ratioX * vp.w);
        const y = Math.round(ev.ratioY * vp.h);

        await page.mouse.click(x, y, {
            button: ev.button === 2 ? 'right' : 'left',
            modifiers: [
                ev.ctrl ? 'Control' : '',
                ev.shift ? 'Shift' : '',
                ev.alt ? 'Alt' : '',
                ev.meta ? 'Meta' : ''
            ].filter(Boolean),
        });
        // console.log('[MirrorController] click', x, y);
    }

    async _replicateKey(page, ev) {
        try {
            const mods = [];
            if (ev.ctrl) mods.push('Control');
            if (ev.shift) mods.push('Shift');
            if (ev.alt) mods.push('Alt');
            if (ev.meta) mods.push('Meta');

            // use o code quando vier (KeyA, Enter, etc.). cai pro key se faltar.
            const key = ev.code || ev.key;

            for (const m of mods) await page.keyboard.down(m);
            await page.keyboard.press(key);
            for (let i = mods.length - 1; i >= 0; i--) await page.keyboard.up(mods[i]);

            // console.log('[MirrorController] key', mods.join('+'), key);
        } catch (e) {
            console.error('[MirrorController] key falhou', ev.key, e.message);
        }
    }

    async _replicateWheel(page, ev) {
        // move o mouse pro mesmo ponto e aplica o delta da roda
        const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        const x = Math.round(ev.ratioX * vp.w);
        const y = Math.round(ev.ratioY * vp.h);

        await page.mouse.move(x, y);
        await page.mouse.wheel(ev.deltaX || 0, ev.deltaY || 0);  //  isso faz o container correto rolar
        // console.log('[MirrorController] wheel', x, y, ev.deltaX, ev.deltaY);
    }

    async _replicateScroll(page, ev) {
        // fallback por posição absoluta do documento (quando vier 'scroll')
        try {
            await page.evaluate(({ rx, ry }) => {
                const maxX = Math.max(1, document.documentElement.scrollWidth - window.innerWidth);
                const maxY = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
                const x = Math.round((rx || 0) * maxX);
                const y = Math.round((ry || 0) * maxY);
                window.scrollTo(x, y);
            }, { rx: ev.ratioX, ry: ev.ratioY });
            // console.log('[MirrorController] scroll abs');
        } catch (e) {
            console.error('[MirrorController] scroll falhou', e.message);
        }
    }
}

module.exports = MirrorController;
