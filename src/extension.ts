import * as vscode from "vscode";
import { Extension } from "vscode";
import { API, Change, GitExtension, Repository, RepositoryState } from "../typings/git";
// import * as Git from "nodegit";

const EXT_ID = '1nm';
const CMD_INIT = `${EXT_ID}:init`;
const CMD_ITER = `${EXT_ID}:iter`;
const INITIAL_MESSAGE_ID = `${EXT_ID}:initial_message`;
const ITERATION_MESSAGE_ID_TEMPLATE = (repo_uri: string | vscode.Uri) => `${EXT_ID}:iteration_message_${repo_uri}`;
const ITERATION_INDEX_ID_TEMPLATE = (repo_uri: string | vscode.Uri) => `${EXT_ID}:iteration_index_${repo_uri}`;
const CMD_REVERT = `${EXT_ID}:cancel`;

export async function activate(context: vscode.ExtensionContext) {

    const git = vscode.workspace.getConfiguration('git');

    try {
        const extension = vscode.extensions.getExtension('vscode.git') as Extension<GitExtension>;
        if (extension !== undefined) {
            const gitExtension = extension.isActive ? extension.exports : await extension.activate();

            const api = gitExtension.getAPI(1);

            let initialized = {};

            const init_workflow = async (repo: Repository) => {
                const status = await repo.status();

                let ready_to_go = repo.state.workingTreeChanges.length === 0;

                if (!ready_to_go) {
                    const initial_commit_message = context.workspaceState.get<string>(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri))
                        || context.workspaceState.get<string>(INITIAL_MESSAGE_ID, null)
                        || repo.inputBox.value
                        || await vscode.window.showInputBox({
                            value: "getting started with rigorous git routines",
                            prompt: `
                                            Your working tree seems to have [${repo.state.workingTreeChanges.length}] change${repo.state.workingTreeChanges.length > 1 ? 's' : ''}, 
                                            let's add a commit message for ${repo.state.workingTreeChanges.length > 1 ? 'these' : 'this'}
                                            `,
                            placeHolder: 'Initial commit message'
                        });

                    if (initial_commit_message && !repo.inputBox.value) {
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

            const on_change_document = (change: vscode.TextDocumentChangeEvent) => {
                if (change.contentChanges.length > 0) {
                    api.repositories.forEach(async (repo) => {
                        if (initialized[repo.rootUri.toString()]) {
                            if (repo.state.workingTreeChanges.length > 0) {
                                console.log(repo.state.workingTreeChanges);
                                console.log(change.document);
                                start_routine(repo, change.document);
                            }
                            else {
                                revert_routine(repo);
                            }
                        }
                        else {
                            api.repositories.forEach(async (repo) => {
                                init_workflow(repo);
                            })
                        }
                    });
                }
                
            }

            const on_open_repository = async (repo: Repository) => {
                await init_workflow(repo);
                context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(on_change_document));
            }


            const start_routine = async (repo: Repository, doc?: vscode.TextDocument) => {
                if (context.workspaceState.get(INITIAL_MESSAGE_ID)) {
                    return;
                }

                let wt_change: Change;
                if (doc) {
                    wt_change = repo.state.workingTreeChanges.find(ch => ch.uri.toString() === doc.uri.toString());

                    if (!wt_change) {
                        return
                    }
                }

                let iteration_message = repo.inputBox.value ||
                    context.workspaceState.get<string>(ITERATION_MESSAGE_ID_TEMPLATE(repo.rootUri));
                let from_input = false;
                if (!iteration_message) {
                    iteration_message = await vscode.window.showInputBox({
                        prompt: `What's going to change?`,
                        placeHolder: 'New commit message',
                    });

                    from_input = true;
                }

                

                if (wt_change) {
                    const iteration_changes = context.workspaceState.get<vscode.Uri[]>(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), []);
                    if (!iteration_changes.find(uri => wt_change.uri.toString() === uri.toString())) {
                        if (!from_input) {
                            iteration_message = (await vscode.window.showQuickPick([{label: 'Yes', description: `Yes, continue with [${iteration_message}]`, default: true, value: true}, {label:'No', description: `No, enter new message`, value: false}])).value ?
                            iteration_message : await vscode.window.showInputBox({
                                prompt: `What's going to change?`,
                                placeHolder: 'New commit message',
                                value: `${iteration_changes.length} new message${iteration_changes.length > 1 ? 's' :''}`
                            });
                        }

                        if (iteration_message) {
                            iteration_changes.push(wt_change.uri)
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

                    if (wt_change) {
                        context.workspaceState.update(ITERATION_INDEX_ID_TEMPLATE(repo.rootUri.toString()), [wt_change.uri]);
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
        console.log('nope', e);
    }


}