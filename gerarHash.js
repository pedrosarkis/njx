const bcrypt = require('bcrypt');

// Altere a senha aqui:
const senha = 'cusin32';

bcrypt.hash(senha, 10, (err, hash) => {
    if (err) {
        console.error('Erro ao gerar hash:', err);
    } else {
        console.log(`Hash gerado para "${senha}":\n${hash}`);
    }
});
