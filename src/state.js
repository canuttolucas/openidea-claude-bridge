import path from 'node:path';
import { EventEmitter } from 'node:events';

const isAbs = (p) => typeof p === 'string' && path.isAbsolute(p) && !/[\0-\x1f]/.test(p);
const inside = (roots, p) => roots.some((r) => { const rel = path.relative(r, path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
const bad = (what) => { throw new Error(`estado inválido: ${what}`); };

/** Estado do editor, alimentado pelo plugin do openIDEA (ou por testes). Valida tudo que recebe. */
export class EditorState extends EventEmitter {
  workspaceFolders = [];
  openEditors = [];   // [{ filePath, isActive, isDirty, languageId }]
  selection = null;   // { filePath, text, selection: { start, end, isEmpty } }  (só para getCurrentSelection)
  diagnostics = {};

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('corpo');
    const { workspaceFolders, openEditors, selection, atMention } = patch;
    // Valida tudo antes de aplicar qualquer coisa.
    if (workspaceFolders !== undefined && !(Array.isArray(workspaceFolders) && workspaceFolders.length <= 64 && workspaceFolders.every(isAbs))) bad('workspaceFolders');
    if (openEditors !== undefined && !(Array.isArray(openEditors) && openEditors.length <= 1000 && openEditors.every((e) => e && isAbs(e.filePath)))) bad('openEditors');
    if (selection != null && !(typeof selection === 'object' && isAbs(selection.filePath) && typeof selection.text === 'string')) bad('selection');
    const roots = (workspaceFolders ?? this.workspaceFolders).map((r) => path.resolve(r));
    if (atMention !== undefined) {
      if (!(atMention && isAbs(atMention.filePath) && inside(roots, atMention.filePath))) bad('atMention fora do workspace');
      for (const k of ['lineStart', 'lineEnd']) if (atMention[k] !== undefined && !Number.isInteger(atMention[k])) bad(`atMention.${k}`);
    }

    if (workspaceFolders && JSON.stringify(workspaceFolders) !== JSON.stringify(this.workspaceFolders)) {
      this.workspaceFolders = workspaceFolders;
      this.emit('workspace_changed');
    }
    if (openEditors) this.openEditors = openEditors.map(({ filePath, isActive, isDirty, languageId }) => ({ filePath, isActive: !!isActive, isDirty: !!isDirty, languageId: typeof languageId === 'string' ? languageId : undefined }));
    if (selection !== undefined) this.selection = selection;
    if (atMention) this.emit('at_mentioned', { filePath: atMention.filePath, lineStart: atMention.lineStart, lineEnd: atMention.lineEnd });
  }
}
