const fs = require('fs');
const path = require('path');

function garantirArquivo(caminho, conteudoPadrao = '') {
    const fs = require('fs');
    if (!fs.existsSync(caminho)) {
        fs.writeFileSync(caminho, conteudoPadrao);
    }
}

//oi
module.exports = {
    garantirArquivo
};
