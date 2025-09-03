const bcrypt = require('bcrypt');

async function gerarHash(senha) {
    const hash = await bcrypt.hash(senha, 10);
    console.log('Hash gerado:', hash);
}

gerarHash('nj8080');
