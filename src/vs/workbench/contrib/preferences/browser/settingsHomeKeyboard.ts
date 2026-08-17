import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { getAllUnboundCommands } from '../../../services/keybinding/browser/unboundCommands.js';
import { IKeybindingEditingService } from '../../../services/keybinding/common/keybindingEditing.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

export function renderSettingsHomeKeyboardPage(
	main: HTMLElement,
	keybindingService: IKeybindingService,
	commandService: ICommandService,
	keybindingEditingService: IKeybindingEditingService,
	disposables: DisposableStore
): void {
	const header = append(main, $('.settings-home-header', { style: 'margin-bottom: 20px;' }));
	append(header, $('h1', { style: 'font-size: 24px; font-weight: 700; margin: 0 0 6px 0;' }, localize('settingsHomeKeyboardTitle', "Raccourcis Clavier")));
	append(header, $('p', { style: 'margin: 0; font-size: 13px; opacity: 0.7;' }, localize('settingsHomeKeyboardLead', "Consultez, recherchez et gérez vos raccourcis clavier. Cliquez sur le crayon pour modifier ou la poubelle pour supprimer.")));

	// Search Input Card
	const searchSection = append(main, $('.settings-home-section', { style: 'max-width: 100%;' }));
	const searchCard = append(searchSection, $('.settings-home-card'));
	searchCard.style.padding = '14px 18px';

	const searchBox = append(searchCard, $('.settings-home-search'));
	searchBox.style.display = 'flex';
	searchBox.style.alignItems = 'center';
	searchBox.style.gap = '10px';
	searchBox.style.padding = '10px 14px';
	searchBox.style.borderRadius = '8px';
	searchBox.style.background = 'var(--vscode-input-background, #1e1e1e)';
	searchBox.style.border = '1px solid var(--vscode-input-border, rgba(255,255,255,0.15))';

	const searchIcon = append(searchBox, renderIcon(Codicon.search));
	searchIcon.style.opacity = '0.7';

	const keySearchInput = append(searchBox, $('input.settings-home-key-search', {
		type: 'search',
		placeholder: localize('keySearchPlaceholder', "Rechercher une commande ou un raccourci (ex: Nouveau chat, Ctrl+N, Terminal...)"),
		'aria-label': localize('keySearchPlaceholder', "Filtrer les raccourcis")
	})) as HTMLInputElement;
	keySearchInput.style.background = 'transparent';
	keySearchInput.style.border = 'none';
	keySearchInput.style.outline = 'none';
	keySearchInput.style.color = 'var(--vscode-input-foreground, #ffffff)';
	keySearchInput.style.width = '100%';
	keySearchInput.style.fontSize = '13px';

	// Codex-Style Shortcuts List Section
	const shortcutsSection = append(main, $('.settings-home-section', { style: 'max-width: 100%; margin-top: 20px;' }));
	const listCard = append(shortcutsSection, $('.settings-home-codex-card'));
	const listContainer = append(listCard, $('.settings-home-codex-list'));

	interface IKeybindingTableRow {
		name: string;
		label: string;
		id: string;
		when?: string;
		source: string;
		sourceType: 'user' | 'extension' | 'default' | 'none';
		rawItem?: ResolvedKeybindingItem;
	}

	let allItems: IKeybindingTableRow[] = [];

	const openEditModal = (item: IKeybindingTableRow) => {
		const overlay = append(document.body, $('.settings-home-key-modal-overlay'));
		const dialog = append(overlay, $('.settings-home-key-modal-dialog'));

		append(dialog, $('h3.settings-home-modal-title', undefined, localize('editShortcutModalTitle', "Modifier le raccourci clavier")));
		append(dialog, $('p.settings-home-modal-subtitle', undefined, `${item.name} (${item.id})`));

		const captureContainer = append(dialog, $('.settings-home-key-capture-container'));
		append(captureContainer, $('span.settings-home-key-capture-label', undefined, localize('pressKeysInstruction', "Appuyez sur la combinaison de touches souhaitée au clavier :")));

		const inputField = append(captureContainer, $('input.settings-home-key-capture-input', {
			type: 'text',
			value: item.label || '',
			placeholder: 'ex: Ctrl+Shift+N',
			'aria-label': 'Combinaison de touches'
		})) as HTMLInputElement;

		let capturedKeys: string[] = [];
		const keyListener = addDisposableListener(inputField, 'keydown', (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === 'Enter') {
				void saveAndClose();
				return;
			}
			if (e.key === 'Escape') {
				closeModal();
				return;
			}

			const parts: string[] = [];
			if (e.ctrlKey) parts.push('Ctrl');
			if (e.shiftKey) parts.push('Shift');
			if (e.altKey) parts.push('Alt');
			if (e.metaKey) parts.push('Cmd');

			let k = e.key;
			if (k === ' ') k = 'Space';
			if (!['Control', 'Shift', 'Alt', 'Meta', 'Unidentified'].includes(k)) {
				if (k.length === 1) {
					k = k.toUpperCase();
				} else if (k.startsWith('Arrow')) {
					k = k.replace('Arrow', '') + 'Arrow';
				}
				parts.push(k);
			}

			if (parts.length > 0) {
				capturedKeys = parts;
				inputField.value = capturedKeys.join('+');
			}
		});

		const actionsRow = append(dialog, $('.settings-home-modal-actions'));
		const cancelBtn = append(actionsRow, $('button.settings-home-modal-btn.secondary', undefined, localize('cancel', "Annuler")));
		const saveBtn = append(actionsRow, $('button.settings-home-modal-btn.primary', undefined, localize('save', "Enregistrer")));

		const closeModal = () => {
			keyListener.dispose();
			overlay.remove();
		};

		const saveAndClose = async () => {
			const newKey = inputField.value.trim();
			closeModal();
			if (!newKey) return;

			try {
				const targetRaw = item.rawItem ?? new ResolvedKeybindingItem(undefined, item.id, null, item.when ? ContextKeyExpr.deserialize(item.when) : undefined, false, null, false);
				if (item.label) {
					await keybindingEditingService.editKeybinding(targetRaw, newKey, item.when);
				} else {
					await keybindingEditingService.addKeybinding(targetRaw, newKey, item.when);
				}
			} catch (err) {
				console.error('[Codex Keyboard] editKeybinding error:', err);
			}
		};

		addDisposableListener(cancelBtn, 'click', closeModal);
		addDisposableListener(saveBtn, 'click', () => void saveAndClose());
		addDisposableListener(overlay, 'click', (e) => {
			if (e.target === overlay) closeModal();
		});

		setTimeout(() => inputField.focus(), 50);
	};

	const openDeleteConfirmModal = (item: IKeybindingTableRow) => {
		const overlay = append(document.body, $('.settings-home-key-modal-overlay'));
		const dialog = append(overlay, $('.settings-home-key-modal-dialog'));

		const header = append(dialog, $('.settings-home-modal-header'));
		const iconSpan = append(header, $('span.settings-home-modal-icon-danger'));
		iconSpan.append(renderIcon(Codicon.warning));
		append(header, $('h3.settings-home-modal-title', undefined, localize('deleteShortcutModalTitle', "Confirmer la suppression")));

		const shortcutLabelStr = item.label ? `[ ${item.label} ] ` : '';
		append(dialog, $('p.settings-home-modal-text', undefined, localize('deleteShortcutConfirmMsg', "Êtes-vous sûr de vouloir supprimer le raccourci {0}pour la commande \"{1}\" ?", shortcutLabelStr, item.name)));

		const actionsRow = append(dialog, $('.settings-home-modal-actions'));
		const cancelBtn = append(actionsRow, $('button.settings-home-modal-btn.secondary', undefined, localize('cancel', "Annuler")));
		const confirmDeleteBtn = append(actionsRow, $('button.settings-home-modal-btn.danger', undefined, localize('delete', "Supprimer")));

		const closeModal = () => {
			overlay.remove();
		};

		const confirmAndClose = async () => {
			closeModal();
			try {
				const targetRaw = item.rawItem ?? new ResolvedKeybindingItem(undefined, item.id, null, item.when ? ContextKeyExpr.deserialize(item.when) : undefined, false, null, false);
				await keybindingEditingService.removeKeybinding(targetRaw);
			} catch (err) {
				console.error('[Codex Keyboard] removeKeybinding error:', err);
			}
		};

		addDisposableListener(cancelBtn, 'click', closeModal);
		addDisposableListener(confirmDeleteBtn, 'click', () => void confirmAndClose());
		addDisposableListener(overlay, 'click', (e) => {
			if (e.target === overlay) closeModal();
		});
	};

	const getCommandDisplayName = (commandId: string): string => {
		try {
			const menuCommand = MenuRegistry.getCommand(commandId);
			if (menuCommand && menuCommand.title) {
				const titleStr = typeof menuCommand.title === 'string' ? menuCommand.title : (menuCommand.title.value || menuCommand.title.original);
				const catStr = typeof menuCommand.category === 'string' ? menuCommand.category : (menuCommand.category?.value || menuCommand.category?.original);
				if (titleStr) {
					return catStr ? `${catStr}: ${titleStr}` : titleStr;
				}
			}
		} catch (err) {
			console.error('[Codex Keyboard] getCommandDisplayName menu lookup error:', err);
		}
		const formattedName = commandId
			.replace(/^[a-z]+\.action\./, '')
			.replace(/^[a-z]+\./, '')
			.replace(/\./g, ' ')
			.replace(/([A-Z])/g, ' $1')
			.trim();
		return formattedName.length > 0 ? formattedName.charAt(0).toUpperCase() + formattedName.slice(1) : commandId;
	};

	const renderRows = (query: string = '') => {
		try {
			clearNode(listContainer);
			const q = (query || '').toLowerCase().trim();
			const filtered = allItems.filter(item => {
				if (!item) return false;
				if (!q) return true;
				const nameStr = (item.name || '').toLowerCase();
				const idStr = (item.id || '').toLowerCase();
				const labelStr = (item.label || '').toLowerCase();
				const whenStr = (item.when || '').toLowerCase();
				const sourceStr = (item.source || '').toLowerCase();
				return nameStr.includes(q) || idStr.includes(q) || labelStr.includes(q) || whenStr.includes(q) || sourceStr.includes(q);
			});

			if (filtered.length === 0) {
				const emptyRow = append(listContainer, $('.settings-home-codex-empty', undefined, localize('noKeybindingsFound', "Aucun raccourci trouvé.")));
				emptyRow.style.padding = '32px';
				emptyRow.style.textAlign = 'center';
				emptyRow.style.opacity = '0.6';
				return;
			}

			for (const item of filtered) {
				try {
					const row = append(listContainer, $('.settings-home-codex-row', { title: item.id }));

					// Info (Title + Description/ID)
					const info = append(row, $('.settings-home-codex-info'));
					append(info, $('.settings-home-codex-title', undefined, item.name || item.id));
					append(info, $('.settings-home-codex-desc', undefined, item.id));

					// Right actions (Pills + Edit + Delete)
					const right = append(row, $('.settings-home-codex-right'));

					if (item.label) {
						const pillGroup = append(right, $('.settings-home-codex-pill-group'));
						const chords = item.label.split(' ').filter(c => c.trim().length > 0);
						for (const chord of chords) {
							append(pillGroup, $('.settings-home-codex-pill', undefined, chord));
						}

						const editBtn = append(right, $('button.settings-home-codex-action-btn', { title: localize('editKeybinding', "Modifier le raccourci"), 'aria-label': localize('editKeybinding', "Modifier le raccourci") }));
						editBtn.append(renderIcon(Codicon.edit));
						disposables.add(addDisposableListener(editBtn, 'click', (e) => {
							e.stopPropagation();
							openEditModal(item);
						}));

						const deleteBtn = append(right, $('button.settings-home-codex-action-btn.delete', { title: localize('resetKeybinding', "Supprimer le raccourci"), 'aria-label': localize('resetKeybinding', "Supprimer le raccourci") }));
						deleteBtn.append(renderIcon(Codicon.trash));
						disposables.add(addDisposableListener(deleteBtn, 'click', (e) => {
							e.stopPropagation();
							openDeleteConfirmModal(item);
						}));
					} else {
						append(right, $('.settings-home-codex-unassigned', undefined, localize('unassignedKeybinding', "Non attribué")));
						const editBtn = append(right, $('button.settings-home-codex-action-btn', { title: localize('addKeybinding', "Attribuer un raccourci"), 'aria-label': localize('addKeybinding', "Attribuer un raccourci") }));
						editBtn.append(renderIcon(Codicon.edit));
						disposables.add(addDisposableListener(editBtn, 'click', (e) => {
							e.stopPropagation();
							openEditModal(item);
						}));
					}

					disposables.add(addDisposableListener(row, 'dblclick', () => {
						openEditModal(item);
					}));
				} catch (rowErr) {
					console.error('[Codex Keyboard] render row error:', rowErr);
				}
			}
		} catch (renderErr) {
			console.error('[Codex Keyboard] renderRows error:', renderErr);
		}
	};

	const fetchAllKeybindings = (): IKeybindingTableRow[] => {
		const result: IKeybindingTableRow[] = [];
		const seenKeys = new Set<string>();
		const boundCommandsMap = new Map<string, boolean>();

		try {
			const liveItems = keybindingService.getKeybindings();
			if (liveItems && Array.isArray(liveItems)) {
				for (const item of liveItems) {
					if (!item || !item.command) { continue; }
					try {
						boundCommandsMap.set(item.command, true);
						let label = '';
						if (item.resolvedKeybinding) {
							label = item.resolvedKeybinding.getLabel() || '';
						}
						const whenStr = item.when ? (typeof item.when === 'string' ? item.when : (typeof item.when.serialize === 'function' ? item.when.serialize() : String(item.when))) : undefined;
						const compositeKey = `${item.command}|${label}|${whenStr ?? ''}`;
						if (!seenKeys.has(compositeKey)) {
							seenKeys.add(compositeKey);
							const displayName = getCommandDisplayName(item.command);

							let source = localize('sourceDefault', "Par défaut");
							let sourceType: 'default' | 'user' | 'extension' | 'none' = 'default';
							if (item.isDefault === false) {
								source = localize('sourceUser', "Utilisateur");
								sourceType = 'user';
							} else if (item.extensionId) {
								source = localize('sourceExtension', "Extension ({0})", item.extensionId);
								sourceType = 'extension';
							}

							result.push({
								name: displayName,
								label: label,
								id: item.command,
								when: whenStr,
								source,
								sourceType,
								rawItem: item
							});
						}
					} catch (itemErr) {
						console.error('[Codex Keyboard] live item error:', itemErr);
					}
				}
			}
		} catch (err) {
			console.error('[Codex Keyboard] getKeybindings error:', err);
		}

		try {
			const defaults = keybindingService.getDefaultKeybindings();
			if (defaults && Array.isArray(defaults)) {
				for (const item of defaults) {
					if (!item || !item.command) { continue; }
					boundCommandsMap.set(item.command, true);
					try {
						let label = '';
						if (item.resolvedKeybinding) {
							label = item.resolvedKeybinding.getLabel() || '';
						}
						const whenStr = item.when ? (typeof item.when === 'string' ? item.when : (typeof item.when.serialize === 'function' ? item.when.serialize() : String(item.when))) : undefined;
						const compositeKey = `${item.command}|${label}|${whenStr ?? ''}`;
						if (!seenKeys.has(compositeKey)) {
							seenKeys.add(compositeKey);
							const displayName = getCommandDisplayName(item.command);
							result.push({
								name: displayName,
								label: label,
								id: item.command,
								when: whenStr,
								source: localize('sourceDefault', "Par défaut"),
								sourceType: 'default',
								rawItem: item
							});
						}
					} catch (defaultErr) {
						console.error('[Codex Keyboard] default item error:', defaultErr);
					}
				}
			}
		} catch (err) {
			console.error('[Codex Keyboard] getDefaultKeybindings error:', err);
		}

		try {
			const unboundList = getAllUnboundCommands(boundCommandsMap);
			if (unboundList && Array.isArray(unboundList)) {
				for (const cmdId of unboundList) {
					if (!cmdId) { continue; }
					const compositeKey = `${cmdId}||-`;
					if (!seenKeys.has(compositeKey)) {
						seenKeys.add(compositeKey);
						try {
							const displayName = getCommandDisplayName(cmdId);
							result.push({
								name: displayName,
								label: '',
								id: cmdId,
								when: '-',
								source: '-',
								sourceType: 'none'
							});
						} catch (unboundErr) {
							console.error('[Codex Keyboard] unbound item error:', unboundErr);
						}
					}
				}
			}
		} catch (err) {
			console.error('[Codex Keyboard] getAllUnboundCommands error:', err);
		}

		const getPriority = (item: IKeybindingTableRow): number => {
			let score = 0;
			if (item.sourceType === 'user') {
				score += 1000;
			}
			if (item.label) {
				score += 500;
			}
			const idLower = item.id.toLowerCase();
			const nameLower = item.name.toLowerCase();
			if (idLower.includes('chat') || nameLower.includes('chat') || idLower.includes('agent') || nameLower.includes('agent')) {
				score += 300;
			}
			if (idLower.includes('new') || idLower.includes('open') || idLower.includes('save') || idLower.includes('find') || idLower.includes('search')) {
				score += 150;
			}
			if (idLower.includes('terminal') || idLower.includes('sidebar') || idLower.includes('view') || idLower.includes('editor')) {
				score += 50;
			}
			return score;
		};

		result.sort((a, b) => {
			const prioA = getPriority(a);
			const prioB = getPriority(b);
			if (prioA !== prioB) {
				return prioB - prioA;
			}
			return a.name.localeCompare(b.name);
		});

		return result;
	};

	allItems = fetchAllKeybindings();
	renderRows();

	disposables.add(addDisposableListener(keySearchInput, 'input', () => {
		renderRows(keySearchInput.value.trim());
	}));

	disposables.add(keybindingService.onDidUpdateKeybindings(() => {
		allItems = fetchAllKeybindings();
		renderRows(keySearchInput.value.trim());
	}));
}
