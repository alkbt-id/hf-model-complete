const vscode = require('vscode');
const { rank } = require('./fuzzy');

// Text before the cursor ends inside the first string argument: from_pretrained('mi
const CALL_RE = /\bfrom_pretrained\(\s*(['"])([^'"]*)$/;
const API = 'https://huggingface.co/api/models';
const FIELDS = 'expand[]=downloads&expand[]=pipeline_tag';
const INDEX_PAGES = 20; // 1000 models per page: the 20k most downloaded models
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RESULTS = 30;
const API_CACHE_KEY = 'apiCache';
const API_CACHE_TTL_MS = 3600 * 1000;

let state; // context.globalState: survives VS Code restarts
let apiCache = {}; // query -> { at, models }, kept for an hour
let index = []; // local copy of popular models, fuzzy-searched on every keystroke

function freshApiCache() {
  const now = Date.now();
  return Object.fromEntries(Object.entries(apiCache).filter(([, v]) => now - v.at < API_CACHE_TTL_MS));
}

async function searchApi(query) {
  const hit = apiCache[query];
  if (hit && Date.now() - hit.at < API_CACHE_TTL_MS) return hit.models;
  const res = await fetch(`${API}?search=${encodeURIComponent(query)}&sort=downloads&limit=${RESULTS}&${FIELDS}`);
  if (!res.ok) throw new Error(`HF API ${res.status}`);
  const models = (await res.json()).map((m) => ({ id: m.id, downloads: m.downloads, pipeline_tag: m.pipeline_tag }));
  apiCache = freshApiCache(); // drop expired entries so the stored cache doesn't grow forever
  apiCache[query] = { at: Date.now(), models };
  state.update(API_CACHE_KEY, apiCache);
  return models;
}

async function downloadIndex() {
  const models = [];
  let url = `${API}?sort=downloads&limit=1000&${FIELDS}`;
  for (let page = 0; url && page < INDEX_PAGES; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HF API ${res.status}`);
    for (const m of await res.json()) models.push({ id: m.id, downloads: m.downloads, pipeline_tag: m.pipeline_tag });
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
  }
  return models;
}

const indexFile = (context) => vscode.Uri.joinPath(context.globalStorageUri, 'models.json');

async function loadIndex(context) {
  const file = indexFile(context);
  try {
    const saved = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString());
    index = saved.models;
    if (Date.now() - saved.fetchedAt < INDEX_MAX_AGE_MS) return;
  } catch {
    // no saved index yet: download it below
  }
  try {
    const models = await downloadIndex();
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify({ fetchedAt: Date.now(), models })));
    index = models;
  } catch (e) {
    console.error('[hf-model-complete] index download failed', e);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The local index gives fuzzy matches (mstrl7b -> Mistral-7B); the API adds rare models it lacks.
async function searchModels(query) {
  let fromApi = [];
  try {
    fromApi = await searchApi(query);
  } catch (e) {
    console.error('[hf-model-complete]', e);
  }
  const byId = new Map(index.map((x) => [x.id, x]));
  for (const x of fromApi) byId.set(x.id, x);
  return rank(byId.values(), query, RESULTS);
}

const describe = (model) => `${model.pipeline_tag ?? '—'} · ${model.downloads?.toLocaleString() ?? '?'} downloads`;

const provider = {
  async provideCompletionItems(document, position, token) {
    const before = document.lineAt(position).text.slice(0, position.character);
    const m = CALL_RE.exec(before);
    if (!m) return undefined;
    const query = m[2];

    // Wait for a pause in typing; a new keystroke cancels this call.
    await sleep(200);
    if (token.isCancellationRequested) return undefined;

    const models = await searchModels(query);

    // Replace everything typed between the quote and the cursor.
    const range = new vscode.Range(position.line, position.character - query.length, position.line, position.character);
    const items = models.map((model, i) => {
      const item = new vscode.CompletionItem(model.id, vscode.CompletionItemKind.Module);
      item.range = range;
      item.filterText = query; // we already filtered; stop VS Code from dropping fuzzy matches
      item.sortText = String(i).padStart(3, '0');
      item.detail = describe(model);
      item.documentation = new vscode.MarkdownString(`[huggingface.co/${model.id}](https://huggingface.co/${model.id})`);
      return item;
    });
    // Incomplete: every next keystroke recomputes the list.
    return new vscode.CompletionList(items, true);
  },
};

// Suggestions inside strings are off by default in VS Code, so any id character triggers us.
const TRIGGERS = [..."'\"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-_."];

async function clearCache(context) {
  apiCache = {};
  await state.update(API_CACHE_KEY, undefined);
  index = [];
  try {
    await vscode.workspace.fs.delete(indexFile(context));
  } catch {
    // already gone
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'HF Model Complete: downloading model list…' },
    () => loadIndex(context),
  );
  vscode.window.showInformationMessage(`HF Model Complete: cache cleared, ${index.length} models in the new list.`);
}

// Pick a model in a search box and insert its id at the cursor; selected text becomes the query and is replaced.
async function insertModelId() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pick = vscode.window.createQuickPick();
  pick.placeholder = 'Search Hugging Face models';
  pick.value = editor.document.getText(editor.selection).trim();

  let request = 0; // only the latest query may update the list
  const update = async (query) => {
    const mine = ++request;
    if (!query) {
      pick.items = [];
      pick.busy = false;
      return;
    }
    pick.busy = true;
    await sleep(200);
    if (mine !== request) return;
    const models = await searchModels(query);
    if (mine !== request) return;
    // alwaysShow: we already filtered; stop the quick pick from dropping fuzzy matches
    pick.items = models.map((m) => ({ label: m.id, description: describe(m), alwaysShow: true }));
    pick.busy = false;
  };
  pick.onDidChangeValue(update);
  update(pick.value);

  const id = await new Promise((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]?.label);
      pick.hide();
    });
    pick.onDidHide(() => resolve(undefined));
    pick.show();
  });
  pick.dispose();
  if (id) await editor.edit((edit) => editor.selections.forEach((sel) => edit.replace(sel, id)));
}

function activate(context) {
  state = context.globalState;
  apiCache = state.get(API_CACHE_KEY, {});
  apiCache = freshApiCache();
  loadIndex(context);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'python' }, provider, ...TRIGGERS),
    vscode.commands.registerCommand('hfModelComplete.clearCache', () => clearCache(context)),
    vscode.commands.registerCommand('hfModelComplete.insertModelId', insertModelId),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
