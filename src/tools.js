import { pathToFileURL } from 'node:url';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const uri = (p) => pathToFileURL(p).href;
const noArgs = { type: 'object', properties: {} };

/**
 * Tools que o CLI chama. Só anuncia o que o host faz de verdade: uma tool que responde
 * "ok" sem fazer nada engana o modelo (getDiagnostics vazio = "sem erros").
 * `host`: { openFile?, openDiff?, closeTab?, closeAllDiffTabs?, diagnostics? }
 */
export function buildTools(state, host) {
  const sel = (msg) => async () => text(state.selection ? { success: true, ...state.selection } : { success: false, message: msg });
  const tools = [
    { name: 'getWorkspaceFolders', description: 'Pastas abertas no workspace', inputSchema: noArgs,
      run: async () => text({ success: true, folders: state.workspaceFolders.map((p) => ({ name: p.split('/').pop(), uri: uri(p), path: p })), rootPath: state.workspaceFolders[0] ?? null }) },
    { name: 'getOpenEditors', description: 'Arquivos vistos no editor desde a ativação do plugin', inputSchema: noArgs,
      run: async () => text({ tabs: state.openEditors.map((e) => ({ uri: uri(e.filePath), isActive: e.isActive, isDirty: e.isDirty, label: e.filePath.split('/').pop(), languageId: e.languageId })) }) },
    { name: 'getCurrentSelection', description: 'Última seleção enviada pelo plugin', inputSchema: noArgs, run: sel('No selection available') },
    { name: 'getLatestSelection', description: 'Última seleção enviada pelo plugin', inputSchema: noArgs, run: sel('No selection available') },
  ];
  if (typeof host.openFile === 'function') {
    tools.push({ name: 'openFile', description: 'Abre um arquivo no editor',
      inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, preview: { type: 'boolean' }, startText: { type: 'string' }, endText: { type: 'string' }, selectToEndOfLine: { type: 'boolean' }, makeFrontmost: { type: 'boolean' } }, required: ['filePath'] },
      run: async (args) => { await host.openFile(args); return text(`Opened file: ${args.filePath}`); } });
  }
  if (host.diagnostics === true) {
    tools.push({ name: 'getDiagnostics', description: 'Diagnósticos de um arquivo ou de todos', inputSchema: { type: 'object', properties: { uri: { type: 'string' } } },
      run: async ({ uri: u } = {}) => text(Object.entries(state.diagnostics).filter(([f]) => !u || uri(f) === u || f === u).map(([f, diagnostics]) => ({ uri: uri(f), diagnostics }))) });
  }
  // Diff só com tela de aprovação: sem ela, anunciar seria auto-aprovar edições.
  if (typeof host.openDiff === 'function') {
    tools.push({ name: 'openDiff', description: 'Mostra um diff e espera aceitar/rejeitar',
      inputSchema: { type: 'object', properties: { old_file_path: { type: 'string' }, new_file_path: { type: 'string' }, new_file_contents: { type: 'string' }, tab_name: { type: 'string' } }, required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'] },
      run: async (args) => {
        const r = await host.openDiff(args);
        return { content: r.accepted
          ? [{ type: 'text', text: 'FILE_SAVED' }, { type: 'text', text: r.contents ?? args.new_file_contents }]
          : [{ type: 'text', text: 'DIFF_REJECTED' }, { type: 'text', text: args.tab_name }] };
      } });
    tools.push({ name: 'close_tab', description: 'Fecha uma aba', inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } }, required: ['tab_name'] },
      run: async (a) => { await host.closeTab?.(a.tab_name); return text('TAB_CLOSED'); } });
    tools.push({ name: 'closeAllDiffTabs', description: 'Fecha todas as abas de diff', inputSchema: noArgs,
      run: async () => text(`CLOSED_${(await host.closeAllDiffTabs?.()) ?? 0}_DIFF_TABS`) });
  }
  return tools;
}
