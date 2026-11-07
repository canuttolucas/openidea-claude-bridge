# openidea-claude-bridge

> Projeto da comunidade, **não afiliado nem endossado** pela Anthropic nem pelo projeto openIDEA. "Claude" e "openIDEA" pertencem aos respectivos donos.

Faz o [openIDEA](https://github.com/l0ng-ai/openidea) aparecer para o [Claude Code](https://claude.com/claude-code) como IDE (`/ide`), como a extensão do VSCode faz. Duas peças:

- **sidecar** (`src/`, Node ≥ 20): servidor MCP sobre WebSocket em `127.0.0.1` com token por sessão. Publica `~/.claude/ide/<porta>.lock` e recebe o estado do editor em `POST /bridge/state`.
- **plugin** (`plugin/`, Rust → WASM): roda dentro do openIDEA e empurra pastas abertas, arquivos vistos e a seleção para o sidecar. Plugins são sandboxed (sem listener nem arquivos), por isso o sidecar existe.

Só Linux por enquanto (systemd para o serviço, caminhos POSIX no lockfile).

## Instalação

```sh
git clone <este repositório> && cd openidea-claude-bridge
npm ci

node src/cli.js --print-token        # mostra o segredo e a chave que o plugin vai usar (cria os arquivos, 0600)
node src/cli.js                      # sobe o sidecar na porta 38911 (--port, BRIDGE_PORT; BRIDGE_DEBUG=1 loga o protocolo)
# ou, para subir no login e reiniciar se cair:
scripts/install-service.sh           # --uninstall remove
```

Plugin (precisa da ferramenta `openidea-plugin`, anexada às [releases do openIDEA](https://github.com/l0ng-ai/openidea/releases); Rust via `rustup`, ou `mise x rust@stable -- …`; o `build` instala o alvo `wasm32-wasip2` sozinho):

```sh
openidea-plugin build plugin         # gera plugin/dist/plugin.wasm e valida como o IDE faria
openidea-plugin link plugin          # carrega a pasta no IDE (use `unlink` para desfazer)
```

No openIDEA, em **Settings › Plugins › Claude Code Bridge**:
1. aprove as capabilities (`net:127.0.0.1` e `secrets` são de risco médio; veja abaixo por quê);
2. defina o **segredo** `bridge-token` e a **configuração** `serverKey` com os dois valores de `--print-token`.

Por fim, faça o `claude` aceitar o sidecar. Em terminal reconhecido como IDE o CLI só aceita o lockfile se o PID for ancestral dele ou se a porta bater com `CLAUDE_CODE_SSE_PORT`. No perfil do shell, **só para o terminal do openIDEA**, para não capturar outras IDEs:

```sh
[ "$TERM_PROGRAM" = OpenIDEA ] && export CLAUDE_CODE_SSE_PORT=38911
```

Depois, no `claude`, `/ide` → openIDEA. No editor, selecione um trecho e rode **Claude Code Bridge: Send Selection to Claude**.

## O que funciona (verificado contra claude 2.1.319 e plugin API 1.2 / openIDEA 0.1.38)

- `/ide` detecta e conecta; handshake MCP completo.
- **Send Selection to Claude** → `@arquivo#Lx-y` no prompt do Claude.
- `getWorkspaceFolders`, `getOpenEditors`, `getCurrentSelection`.
- `getOpenEditors` é a lista de **arquivos vistos desde que o plugin ativou**, não as abas abertas: a API não tem evento de fechar arquivo, e o IDE recolhe a instância do plugin depois de uns minutos parada (a lista recomeça vazia). `isDirty` é sempre `false`.

## O que a API de plugins do openIDEA não permite (e o que fazemos)

- **Sem evento de mudança de seleção:** a seleção só chega por comando, nunca ao vivo.
- **Sem leitura de diagnósticos do LSP:** `getDiagnostics` **não é anunciado**.
- **Sem tela de diff:** `openDiff` **não é anunciado**, então o CLI usa o diff do terminal. Anunciá-lo sem uma tela de aprovação auto-aprovaria edições.
- `openFile` também não é anunciado: o plugin não tem como abrir arquivo no editor.

O sidecar só anuncia as tools que o host realmente cumpre, para o Claude nunca tratar "não sei" como "sem erros".

## Segurança e modelo de ameaça

Pensado para **uma máquina de um único usuário**.

- O servidor só escuta em `127.0.0.1`. O WebSocket exige o token da sessão (no lockfile, 0600, em diretório 0700). Página web aberta no navegador não consegue conectar: exigiria um header customizado.
- O canal do plugin (`POST /bridge/state`) usa outro token, persistente (`~/.config/openidea-claude-bridge/control-token`, 0600), e o sidecar valida o estado recebido (a @-menção só vale dentro do workspace).
- **Porta fixa pode ser ocupada por outro processo.** Para ele não receber o token, o plugin pede ao sidecar uma prova antes de enviá-lo: um HMAC de um nonce novo com a `serverKey`. Quem só ocupou a porta não conhece a chave e nada sai do plugin. O segredo é injetado pelo IDE no header; o código do plugin nunca o lê.
- Em máquina **multiusuário**, containers com `--network=host` ou projeto aberto por SSH em host compartilhado, outros usuários alcançam o loopback. A prova acima cobre o roubo do token, mas não troque a porta por uma previsível nem compartilhe o `~/.config/openidea-claude-bridge`.
- `BRIDGE_DEBUG=1` grava no log o protocolo e os nomes de campo do estado (nunca tokens nem o texto selecionado).
- Para rotacionar: apague `~/.config/openidea-claude-bridge/{control-token,server-key}`, rode `--print-token` e atualize o segredo e a configuração no plugin.

## Testes

```sh
npm test                             # sidecar (protocolo, lockfile, segredos, CLI)
cd plugin && cargo test              # plugin, contra o host simulado do SDK
```

## Licença

Apache-2.0 (veja `LICENSE` e `NOTICE`).
