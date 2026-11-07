# Claude Code Bridge (plugin do openIDEA)

Plugin WASM que empurra pastas abertas, arquivos vistos e a seleção do openIDEA para o sidecar
[`openidea-claude-bridge`](..), que fala o protocolo `/ide` do Claude Code. Sozinho ele não faz nada:
precisa do sidecar rodando. Instalação e uso estão no [README da raiz](../README.md).

**Comandos:** *Send Selection to Claude* (vira `@arquivo#Lx-y` no Claude) e *Sync and Check Connection*.

**Capabilities** (todas obrigatórias, cada uma com uso real):
`project.read` (pastas abertas), `editor.read` (seleção), `events` (arquivo ativo),
`net:127.0.0.1` (só o sidecar local) e `secrets` (token de controle, que o plugin nunca lê: o IDE o injeta no header).

**Configuração:** segredo `bridge-token` e setting `serverKey` (valores de `node src/cli.js --print-token`) e, se mudou, `port`.
O plugin só envia o token depois de o sidecar provar que conhece a `serverKey`.

    mise x rust@stable -- cargo test        # testes contra o host simulado do SDK
    openidea-plugin build .                  # gera dist/plugin.wasm e valida como o IDE faria
