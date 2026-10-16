# Adaptus Agentes

Seus agentes do Claude (Cowork e Claude Code) trabalhando num escritório pixel-art, em tempo real.
Produto da **Adaptus Tecnologia** — https://agentes.adaptustecnologia.com.br

- Cada sessão do Claude vira um boneco, com o nome da sessão.
- **Trabalhando** senta no computador; **ociosa** anda pelo escritório; **esperando você** (pergunta ou
  aprovação) mostra um aviso, toca um som e conta no título da aba. Depois de 5 min parada, a sessão
  sai do escritório e volta quando retomar.
- Painel com todas as sessões, histórico de atividade e filtro por status.
- **Escritórios conectados**: peça para ver o escritório de alguém; quando a pessoa aceita, os dois
  podem visitar o escritório um do outro (só visualização).

## Versão hospedada (`hosted/`)

`hosted/gateway.js` é o portão HTTP: uma sala (um servidor do escritório) por pessoa, entrada por chave,
plugin do Cowork e instaladores do Claude Code gerados por sala, e recebimento dos eventos (`POST /in`).
O plugin só repassa eventos; nome, status e regras de exibição ficam no servidor, então atualizar o
servidor atualiza todo mundo.

- Deploy: Railway, `hosted/Dockerfile`, volume em `/data`, variáveis `ADMIN_TOKEN` e `PUBLIC_URL`.
- Criar uma sala: `POST /admin/salas {"nome": "..."}` com `Authorization: Bearer $ADMIN_TOKEN`
  (a resposta traz o link do escritório, do plugin e os comandos de instalação).

Privacidade: só o nome da ferramenta e o arquivo/comando/busca (até 160 caracteres). Nunca o texto
das mensagens nem o conteúdo dos arquivos.

## Build local

```
npm ci --include=dev --ignore-scripts
node esbuild.js
cd webview-ui && npm run build
node dist/cli.js --port 4242
```

## Créditos

Baseado no projeto de código aberto Pixel Agents, de Pablo De Lucca (licença MIT — veja `LICENSE`).
