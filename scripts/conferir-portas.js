// Confere as portas que o nginx publica no host, a partir do "docker compose config --format json" (stdin).
// Uso: docker compose config --format json | node scripts/conferir-portas.js 80
//
// O Compose soma as listas de portas de todos os arquivos (-f). Uma porta posta no docker-compose.yml base vale
// também em produção, e a produção já perdeu a 80 (renovação do certificado e redirecionamento para HTTPS) assim.
'use strict';

const esperadas = process.argv.slice(2).sort();
let entrada = '';
process.stdin.on('data', (c) => (entrada += c));
process.stdin.on('end', () => {
  const portas = (JSON.parse(entrada).services.nginx.ports ?? []).map((p) => String(p.published)).sort();
  if (JSON.stringify(portas) !== JSON.stringify(esperadas)) {
    console.error(`nginx publica [${portas}], esperado [${esperadas}]`);
    process.exit(1);
  }
  console.log(`nginx publica [${portas}]`);
});
