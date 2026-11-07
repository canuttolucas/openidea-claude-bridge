//! Claude Code Bridge: empurra o estado do openIDEA para o sidecar
//! `openidea-claude-bridge`, que fala o protocolo `/ide` do Claude Code.
//!
//! O que a API de plugins permite, e o que não: há evento de foco/abertura de arquivo
//! (arquivo ativo, lista de editores) e a seleção só existe dentro de um comando. Não há
//! evento de mudança de seleção, leitura de diagnósticos do LSP nem tela de diff.

use hmac::{Hmac, Mac};
use openidea_plugin::{
    Error, Event, EventKind, HttpRequest, Invocation, NotificationLevel, Plugin, Range, host, register_plugin, text,
};
use serde_json::{Value, json};
use sha2::Sha256;

const DEFAULT_PORT: u32 = 38911;
/// Um comando tem 5 s de orçamento: sem timeout próprio, um servidor que aceita e não responde derruba a instância.
const TIMEOUT_MS: u32 = 1500;

#[derive(Default)]
pub struct Main {
    editors: Vec<String>,
    active: Option<String>,
}

fn port() -> u32 {
    host::setting_number("port")
        .filter(|p| (1024.0..=65535.0).contains(p) && p.fract() == 0.0)
        .map_or(DEFAULT_PORT, |p| p as u32)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    (s.len() % 2 == 0).then(|| ())?;
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn request(mut req: HttpRequest) -> HttpRequest {
    req.timeout_ms = Some(TIMEOUT_MS);
    req
}

/// Antes de entregar o segredo, o sidecar prova que conhece a `serverKey` (HMAC de um nonce novo).
/// Quem só ocupou a porta não sabe a chave, então nunca recebe o token.
fn verify_sidecar() -> Result<(), Error> {
    let key = host::setting_string("serverKey")
        .filter(|k| !k.trim().is_empty())
        .ok_or("defina \"serverKey\" em Settings › Plugins › Claude Code Bridge (linha serverKey de `node src/cli.js --print-token`)")?;
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| Error::from(format!("sem aleatoriedade: {e}")))?;
    let nonce = hex(&raw);
    let url = format!("http://127.0.0.1:{}/bridge/hello?n={nonce}", port());
    let resp = host::fetch(&request(HttpRequest::get(&url)))?;
    let proof = (resp.status == 200).then(|| unhex(resp.text().trim())).flatten();
    let mut mac = Hmac::<Sha256>::new_from_slice(key.trim().as_bytes()).map_err(|_| Error::from("serverKey inválida"))?;
    mac.update(nonce.as_bytes());
    match proof {
        Some(p) if mac.verify_slice(&p).is_ok() => Ok(()),
        _ => Err("o processo na porta não provou ser o sidecar (serverKey errada ou porta ocupada por outro programa); nada foi enviado".into()),
    }
}

/// POST /bridge/state. O token vai como `{{secret:...}}`: o IDE o preenche, o plugin nunca o vê.
fn post(body: &Value) -> Result<(), Error> {
    if !host::secret_is_set("bridge-token") {
        return Err("defina o segredo \"bridge-token\" em Settings › Plugins (linha bridge-token de `node src/cli.js --print-token`)".into());
    }
    verify_sidecar()?;
    let url = format!("http://127.0.0.1:{}/bridge/state", port());
    let req = HttpRequest::post(&url, body.to_string())
        .header("content-type", "application/json")
        .header("x-bridge-token", "{{secret:bridge-token}}");
    match host::fetch(&request(req))?.status {
        204 => Ok(()),
        401 => Err("o sidecar recusou o token: confira o segredo \"bridge-token\"".into()),
        400 => Err("o sidecar rejeitou o estado enviado (veja o log com BRIDGE_DEBUG=1)".into()),
        s => Err(format!("sidecar respondeu HTTP {s}").into()),
    }
}

fn workspace_folders() -> Vec<String> {
    host::projects().unwrap_or_default().iter().filter_map(|p| p.root().ok()).collect()
}

/// Extensão do nome do arquivo (não do caminho inteiro); o IDE não informa o language id nos eventos.
fn lang_of(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    name.rsplit_once('.').map(|(_, e)| e).filter(|e| !e.is_empty())
}

impl Main {
    fn push_editors(&self) -> Result<(), Error> {
        let tabs: Vec<Value> = self
            .editors
            .iter()
            .map(|p| json!({ "filePath": p, "isActive": self.active.as_deref() == Some(p), "isDirty": false, "languageId": lang_of(p) }))
            .collect();
        let mut body = json!({ "openEditors": tabs });
        let folders = workspace_folders();
        if !folders.is_empty() {
            body["workspaceFolders"] = json!(folders);
        }
        post(&body)
    }

    fn touch(&mut self, path: &str) {
        if !self.editors.iter().any(|p| p == path) {
            self.editors.push(path.to_owned());
        }
    }
}

/// Texto, e intervalo em linhas, de uma seleção.
fn selection_payload(path: &str, doc: &str, r: Range) -> Value {
    let (a, b) = (text::offset(doc, r.start).unwrap_or(doc.len()), text::offset(doc, r.end).unwrap_or(doc.len()));
    let (a, b) = (a.min(b), a.max(b));
    json!({
        "success": true,
        "text": doc.get(a..b).unwrap_or(""),
        "filePath": path,
        "fileUrl": format!("file://{path}"),
        "selection": {
            "start": { "line": r.start.line, "character": r.start.character },
            "end": { "line": r.end.line, "character": r.end.character },
            "isEmpty": r.start == r.end,
        },
    })
}

impl Main {
    /// O retorno de `run_command` é descartado quando o comando roda por uma ação, então o sucesso é
    /// notificado aqui. Erros o IDE já mostra ("<título> failed: …"): notificar de novo duplicaria.
    fn report(r: Result<Option<String>, Error>) -> Result<Option<String>, Error> {
        if let Ok(Some(m)) = &r {
            host::notify(NotificationLevel::Info, "Claude Code Bridge", m);
        }
        r
    }
}

impl Plugin for Main {
    fn activate(&mut self, _ctx: &openidea_plugin::Context) -> Result<(), Error> {
        host::subscribe(EventKind::EditorFocused)?;
        host::subscribe(EventKind::FileOpened)?;
        Ok(())
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Self::report(self.run(id, ctx))
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        self.on_events(events);
    }
}

impl Main {
    fn run(&mut self, id: &str, ctx: &Invocation) -> Result<Option<String>, Error> {
        match id {
            "sync" => {
                self.push_editors()?;
                Ok(Some(format!("Sidecar na porta {} respondeu.", port())))
            }
            "send-selection" => {
                let editor = ctx.editor().ok_or("nenhum arquivo em foco")?;
                let path = editor.path();
                let doc = editor.document()?.text;
                let r = editor.selections()?.into_iter().next().ok_or("sem seleção")?;
                if r.start == r.end {
                    return Err("selecione um trecho antes de enviar".into());
                }
                // Seleção que termina na coluna 0 da linha seguinte não inclui essa linha.
                let line_end = if r.end.character == 0 && r.end.line > r.start.line { r.end.line - 1 } else { r.end.line };
                self.touch(&path);
                self.active = Some(path.clone());
                post(&json!({
                    "selection": selection_payload(&path, &doc, r),
                    "atMention": { "filePath": path, "lineStart": r.start.line, "lineEnd": line_end },
                }))?;
                Ok(Some(format!("Enviado ao Claude: {path}:{}-{}", r.start.line + 1, line_end + 1)))
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn on_events(&mut self, events: &[Event]) {
        for e in events {
            match e {
                Event::FileOpened(p) => self.touch(p),
                Event::EditorFocused(Some(p)) => {
                    self.touch(p);
                    self.active = Some(p.clone());
                }
                Event::EditorFocused(None) => self.active = None,
                _ => {}
            }
        }
        // Sidecar fora do ar não é erro do plugin: o próximo evento tenta de novo.
        if let Err(e) = self.push_editors() {
            host::log(openidea_plugin::LogLevel::Debug, &format!("sidecar indisponível: {e:?}"));
        }
    }
}

register_plugin!(Main);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::{HttpResponse, mock::MockHost};

    const CAPS: &[&str] = &["project.read", "editor.read", "events", "net:127.0.0.1", "secrets"];
    const KEY: &str = "k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k";

    fn resp(status: u16, body: &str) -> HttpResponse {
        HttpResponse { status, headers: vec![], body: body.as_bytes().to_vec() }
    }

    fn proof(key: &str, url: &str) -> String {
        let nonce = url.split("n=").nth(1).unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(nonce.as_bytes());
        hex(&mac.finalize().into_bytes())
    }

    /// Host com segredo, chave e um "sidecar" que prova a identidade com `server_key`.
    fn setup(server_key: &str) -> MockHost {
        let host = MockHost::install().with_capabilities(CAPS);
        host.set_secret("bridge-token", "t");
        host.set_setting("serverKey", &format!("\"{KEY}\""));
        let server_key = server_key.to_owned();
        host.on_fetch(move |r| {
            Ok(if r.url.contains("/bridge/hello") { resp(200, &proof(&server_key, &r.url)) } else { resp(204, "") })
        });
        host
    }

    fn states(host: &MockHost) -> Vec<Value> {
        host.requests()
            .iter()
            .filter(|r| r.url.ends_with("/bridge/state"))
            .map(|r| serde_json::from_slice(r.body.as_ref().unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn envia_selecao_como_atmention_depois_de_verificar_o_sidecar() {
        let host = setup(KEY);
        host.open_editor("/p/a.ts", "typescript", "um\ndois\ntres\n", &[(0, 0, 2, 0)]);
        let msg = Main::default().run_command("send-selection", &host.invocation(), None).unwrap().unwrap();
        assert!(msg.contains("/p/a.ts:1-2"), "{msg}");
        let reqs = host.requests();
        assert!(reqs[0].url.contains("/bridge/hello?n="), "a prova vem antes do segredo");
        assert!(!reqs[0].headers.iter().any(|(n, _)| n == "x-bridge-token"), "a prova não leva o token");
        assert_eq!(reqs[1].url, "http://127.0.0.1:38911/bridge/state");
        assert!(reqs[1].headers.iter().any(|(n, v)| n == "x-bridge-token" && v == "t"), "o IDE preenche o segredo no header");
        assert!(reqs.iter().all(|r| r.timeout_ms == Some(TIMEOUT_MS)), "toda chamada tem timeout próprio");
        let body = &states(&host)[0];
        assert_eq!(body["atMention"], json!({ "filePath": "/p/a.ts", "lineStart": 0, "lineEnd": 1 }));
        assert_eq!(body["selection"]["text"], "um\ndois\n");
    }

    #[test]
    fn impostor_na_porta_nao_recebe_o_token() {
        let host = setup("outra-chave-que-o-impostor-inventou-xx");
        let e = Main::default().run_command("sync", &host.invocation(), None).unwrap_err();
        assert!(format!("{e:?}").contains("não provou"), "{e:?}");
        assert!(states(&host).is_empty(), "nenhum POST com o segredo pode ter saído");
        assert!(!host.requests().iter().any(|r| r.headers.iter().any(|(_, v)| v == "t")), "o segredo não pode ter saído");
    }

    #[test]
    fn resposta_de_prova_malformada_tambem_e_recusada() {
        for body in ["", "zz", "abc", "00"] {
            let host = setup(KEY);
            host.on_fetch(move |_| Ok(resp(200, body)));
            assert!(Main::default().run_command("sync", &host.invocation(), None).is_err(), "{body:?}");
            assert!(states(&host).is_empty());
        }
        let host = setup(KEY);
        host.on_fetch(|_| Ok(resp(500, "")));
        assert!(Main::default().run_command("sync", &host.invocation(), None).is_err());
    }

    #[test]
    fn sem_serverkey_ou_sem_segredo_a_mensagem_diz_o_que_fazer() {
        let host = setup(KEY);
        host.set_setting("serverKey", "\"\"");
        let e = Main::default().run_command("sync", &host.invocation(), None).unwrap_err();
        assert!(format!("{e:?}").contains("serverKey"), "{e:?}");
        assert!(host.requests().is_empty());

        let host = MockHost::install().with_capabilities(CAPS);
        host.on_fetch(|_| Ok(resp(204, "")));
        let e = Main::default().run_command("sync", &host.invocation(), None).unwrap_err();
        assert!(format!("{e:?}").contains("bridge-token"), "{e:?}");
    }

    #[test]
    fn selecao_vazia_nao_envia() {
        let host = setup(KEY);
        host.open_editor("/p/a.ts", "typescript", "um\n", &[(0, 1, 0, 1)]);
        assert!(Main::default().run_command("send-selection", &host.invocation(), None).is_err());
        assert!(host.requests().is_empty());
    }

    #[test]
    fn selecao_que_termina_na_coluna_zero_nao_inclui_a_linha_seguinte() {
        let host = setup(KEY);
        host.open_editor("/p/a.ts", "typescript", "um\ndois\ntres", &[(1, 0, 2, 0)]);
        Main::default().run_command("send-selection", &host.invocation(), None).unwrap();
        assert_eq!(states(&host)[0]["atMention"], json!({ "filePath": "/p/a.ts", "lineStart": 1, "lineEnd": 1 }));
    }

    #[test]
    fn eventos_atualizam_editores_e_ativo() {
        let host = setup(KEY);
        host.set_project_root(Some("/p"));
        let mut m = Main::default();
        m.handle_events(&[Event::FileOpened("/p/a.rs".into()), Event::EditorFocused(Some("/p/b.rs".into()))], &host.invocation());
        let body = states(&host).pop().unwrap();
        assert_eq!(body["workspaceFolders"], json!(["/p"]));
        assert_eq!(body["openEditors"][0]["isActive"], false);
        assert_eq!(body["openEditors"][1], json!({ "filePath": "/p/b.rs", "isActive": true, "isDirty": false, "languageId": "rs" }));
        m.handle_events(&[Event::EditorFocused(None)], &host.invocation());
        assert!(states(&host).pop().unwrap()["openEditors"].as_array().unwrap().iter().all(|e| e["isActive"] == false));
    }

    #[test]
    fn language_vem_do_nome_do_arquivo_nao_do_caminho() {
        assert_eq!(lang_of("/p/a.ts"), Some("ts"));
        assert_eq!(lang_of("/p/proj.v2/Makefile"), None);
        assert_eq!(lang_of("/p/.gitignore"), Some("gitignore"));
        assert_eq!(lang_of("/p/a."), None);
    }

    #[test]
    fn sem_pastas_abertas_o_plugin_nao_apaga_as_do_sidecar() {
        let host = setup(KEY);
        host.set_project_root(None);
        Main::default().handle_events(&[Event::FileOpened("/p/a.rs".into())], &host.invocation());
        assert!(states(&host)[0].get("workspaceFolders").is_none());
    }

    #[test]
    fn sidecar_fora_do_ar_nao_derruba_eventos_mas_o_comando_reporta() {
        let host = setup(KEY);
        host.on_fetch(|_| Err(Error::Failed("connection refused".into())));
        let mut m = Main::default();
        m.handle_events(&[Event::FileOpened("/p/a.rs".into())], &host.invocation());
        assert!(m.run_command("sync", &host.invocation(), None).is_err());
    }

    #[test]
    fn token_recusado_vira_mensagem_acionavel() {
        let host = setup(KEY);
        host.on_fetch(|r| Ok(if r.url.contains("/bridge/hello") { resp(200, &proof(KEY, &r.url)) } else { resp(401, "") }));
        let e = Main::default().run_command("sync", &host.invocation(), None).unwrap_err();
        assert!(format!("{e:?}").contains("bridge-token"), "{e:?}");
    }

    #[test]
    fn porta_configurada_e_validada() {
        let host = setup(KEY);
        host.set_setting("port", "40000");
        assert_eq!(port(), 40000);
        host.set_setting("port", "80");
        assert_eq!(port(), DEFAULT_PORT);
        host.set_setting("port", "40000.5");
        assert_eq!(port(), DEFAULT_PORT);
    }

    #[test]
    fn sucesso_notifica_e_erro_nao_duplica_a_notificacao_do_ide() {
        let host = setup(KEY);
        Main::default().run_command("sync", &host.invocation(), None).unwrap();
        assert_eq!(host.notifications().len(), 1);
        let host = setup("outra-chave-que-o-impostor-inventou-xx");
        let _ = Main::default().run_command("sync", &host.invocation(), None);
        assert!(host.notifications().is_empty(), "erro: o IDE já mostra");
    }
}
