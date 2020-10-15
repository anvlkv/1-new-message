import * as vscode from "vscode";
import { Extension } from "vscode";
import { API, Change, GitExtension, Repository, RepositoryState } from "../typings/git";

const EXT_ID = '1nm';
const CMD_INIT = `${EXT_ID}:init`;
const CMD_ITER = `${EXT_ID}:iter`;
const INITIAL_MESSAGE_ID = `${EXT_ID}:initial_message`;
const CMD_REVERT = `${EXT_ID}:cancel`;
const ITERATION_MESSAGE_ID_TEMPLATE = (repo_uri: string | vscode.Uri) => `${EXT_ID}:iteration_message_${repo_uri}`;
const ITERATION_INDEX_ID_TEMPLATE = (repo_uri: string | vscode.Uri) => `${EXT_ID}:iteration_index_${repo_uri}`;
const NEW_MESSAGE_TEMPLATE = (count: number) => `${count} new message${count > 1 ? 's' : ''}`

export async function activate(context: vscode.ExtensionContext) {

    const git = vscode.workspace.getConfiguration('git');

    try {
        const extension = vscode.extensions.getExtension('vscode.git') as Extension<GitExtension>;
        if (extension !== undefined) {
            const gitExtension = extension.isActive ? extension.exports : await extension.activate();

            const api = gitExtension.getAPI(1);

            let initialized = {};

            const init_workflow = async (repo: Repository) => {
                await repo.status();
                
                let ready_to_go = repo.state.workingTreeChanges.length === 0;

                if (!ready_to_go) {
                    const initial_commit_message = repo.inputBox.value 
                        || context.workspaceState.get<string>(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri))
                        || context.workspaceState.get<string>(INITIAL_MESSAGE_ID, null)
                        || await vscode.window.showInputBox({
                            value: repo.inputBox.value || "getting started with rigorous git routines",
                            prompt: `
                                            Your working tree seems to have [${repo.state.workingTreeChanges.length}] change${repo.state.workingTreeChanges.length > 1 ? 's' : ''}, 
                                            let's add a commit message for ${repo.state.workingTreeChanges.length > 1 ? 'these' : 'this'}
                                            `,
                            placeHolder: 'Initial commit message'
                        });

                    if (initial_commit_message) {
                        repo.inputBox.value = initial_commit_message;
                        context.workspaceState.update(INITIAL_MESSAGE_ID, initial_commit_message);
                    }

                    initialized[repo.rootUri.toString()] = false;
                }
                else {
                    initialized[repo.rootUri.toString()] = true;
                    context.workspaceState.update(INITIAL_MESSAGE_ID, null);
                }
            }

            const with_repos = (cb: (repo: Repository) => void) => {
                api.repositories.forEach(async (repo) => {
                    await repo.status();

                    if (initialized[repo.rootUri.toString()]) {
                        if (repo.state.workingTreeChanges.length > 0) {
                            cb(repo);
                        }
                        else {
                            revert_routine(repo);
                        }
                    }
                    else {
                        init_workflow(repo);
                    }
                });
            }

            const on_change_document = (change: vscode.TextDocumentChangeEvent) => {
                if (change.contentChanges.length && !change.document.isDirty && change.document.uri.scheme == 'file') {
                    with_repos((repo) => start_routine(repo, change.document.uri));
                }
            }

            const on_save_document = (doc: vscode.TextDocument) => {
                with_repos((repo) => start_routine(repo, doc.uri));
            }

            const on_delete_files = (e: vscode.FileDeleteEvent) => {
                with_repos((repo) => start_routine(repo, e.files));
            }

            const on_rename_files = (e: vscode.FileRenameEvent) => {
                with_repos((repo) => start_routine(repo, e.files.map(f => f.oldUri)));
            }

            const on_create_files = (e: vscode.FileCreateEvent) => {
                with_repos((repo) => start_routine(repo, e.files));
            }

            const on_open_repository = async (repo: Repository) => {
                await init_workflow(repo);
                context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(on_change_document));
                context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(on_save_document));
                context.subscriptions.push(vscode.workspace.onDidDeleteFiles(on_delete_files));
                context.subscriptions.push(vscode.workspace.onDidRenameFiles(on_rename_files));
                context.subscriptions.push(vscode.workspace.onDidCreateFiles(on_create_files));

            }


            const start_routine = async (repo: Repository,  docUris?: vscode.Uri | readonly vscode.Uri[]) => {
                if (context.workspaceState.get(INITIAL_MESSAGE_ID)) {
                    return;
                }

                let wt_changes: Change[];

                if (docUris) {
                    docUris = docUris instanceof Array ? docUris : [docUris];

                    wt_changes = repo.state.workingTreeChanges.filter(ch => (docUris as readonly vscode.Uri[]).find(u => u.toString()=== ch.uri.toString()));

                    if (!wt_changes.length) {
                        return
                    }
                }

                const iteration_changes = context.workspaceState.get<vscode.Uri[]>(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), []);

                let iteration_message = repo.inputBox.value || context.workspaceState.get<string>(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri));
                let from_input = false;
                if (!iteration_message 
                    && (!wt_changes 
                        || !wt_changes.every(ch  => iteration_changes.find(uri => ch.uri.toString() === uri.toString())))) {
                    iteration_message = await vscode.window.showInputBox({
                        prompt: `What's going to change?`,
                        placeHolder: 'New commit message',
                        value: repo.inputBox.value || NEW_MESSAGE_TEMPLATE(iteration_changes.length || 1)
                    });

                    from_input = true;
                }



                if (wt_changes && iteration_message) {
                    if (!wt_changes.every(ch  => iteration_changes.find(uri => ch.uri.toString() === uri.toString()))) {
                        if (!from_input) {
                            const quickPick = vscode.window.createQuickPick();
                            quickPick.items = [
                                { label: 'Yes', description: `Yes, continue with [${iteration_message}]`}, 
                                { label: 'No', description: `No, enter new message`},
                                { label: '$(plus)', description: 'Use entered text as new message', alwaysShow: true}
                            ];
                            quickPick.show();
                            const isSameMessage: vscode.QuickPickItem = await new Promise(c => quickPick.onDidAccept(() => c(quickPick.activeItems[0])));
                            quickPick.hide();
                            
                            if (isSameMessage && isSameMessage.label !== 'Yes') {

                                const updated_iteration_message = isSameMessage.label !== 'No' ? quickPick.value : await vscode.window.showInputBox({
                                    prompt: `What's going to change?`,
                                    placeHolder: 'New commit message',
                                    value: NEW_MESSAGE_TEMPLATE(iteration_changes.length)
                                });

                                if (updated_iteration_message) {
                                    iteration_message = updated_iteration_message;
                                }
                            }
                        }

                        if (iteration_message) {
                            iteration_changes.push(...wt_changes.map(ch => ch.uri))
                        }

                    }
                    context.workspaceState.update(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), iteration_changes);
                }

                if (iteration_message) {
                    context.workspaceState.update(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri), iteration_message);
                    repo.inputBox.value = iteration_message;
                }
                else {
                    revert_routine(repo);

                    if (wt_changes) {
                        context.workspaceState.update(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), [...wt_changes.map(ch => ch.uri)]);
                    }
                }
            }

            const revert_routine = (repo: Repository) => {
                repo.inputBox.value = '';
                context.workspaceState.update(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), []);
                context.workspaceState.update(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri), '');
            }


            context.subscriptions.push(vscode.commands.registerCommand(CMD_INIT, init_workflow));

            context.subscriptions.push(vscode.commands.registerCommand(CMD_ITER, async () => {
                const repos = (api.repositories.some(r => r.ui.selected) ? api.repositories.filter(r => r.ui.selected) : api.repositories);
                let repo = repos[0];
                if (repos.length > 1) {
                    const selected_root_uri = await vscode.window.showQuickPick(repos.map(r => r.rootUri.toString()));
                    if (!selected_root_uri) {
                        return;
                    }
                    repo = repos.find(r => r.rootUri.toString() === selected_root_uri);
                }
                return start_routine(repo);
            }));

            context.subscriptions.push(vscode.commands.registerCommand(CMD_REVERT, async () => {
                const repos = (api.repositories.some(r => r.ui.selected) ? api.repositories.filter(r => r.ui.selected) : api.repositories);
                let repo = repos[0];
                if (repos.length > 1) {
                    const selected_root_uri = await vscode.window.showQuickPick(repos.map(r => r.rootUri.toString()));
                    if (!selected_root_uri) {
                        return;
                    }
                    repo = repos.find(r => r.rootUri.toString() === selected_root_uri);
                }
                return revert_routine(repo);
            }));

            context.subscriptions.push(api.onDidOpenRepository(on_open_repository));
        }
    } catch (e) {
        vscode.window.showWarningMessage(`f**k it i quit with ${e}`)
    }


}