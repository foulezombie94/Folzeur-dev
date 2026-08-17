/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../platform/progress/common/progress.js';
import { IPaneComposite } from '../../workbench/common/panecomposite.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { PaneCompositeDescriptor, Extensions } from '../../workbench/browser/panecomposite.js';
import { IPaneCompositePart } from '../../workbench/browser/parts/paneCompositePart.js';
import { SINGLE_WINDOW_PARTS, Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { PanelPart } from './parts/panelPart.js';
import { SidebarPart } from './parts/sidebarPart.js';
import { AuxiliaryBarPart } from './parts/auxiliaryBarPart.js';
import { MobilePanelPart } from './parts/mobile/mobilePanelPart.js';
import { MobileSidebarPart } from './parts/mobile/mobileSidebarPart.js';
import { MobileAuxiliaryBarPart } from './parts/mobile/mobileAuxiliaryBarPart.js';
import { getClientArea } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IAgentWorkbenchLayoutService } from './workbench.js';
import { SinglePaneMainEditorPart } from './parts/singlePaneEditorPart.js';

export class AgenticPaneCompositePartService extends Disposable implements IPaneCompositePartService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidPaneCompositeOpen = this._register(new Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>());
	readonly onDidPaneCompositeOpen = this._onDidPaneCompositeOpen.event;

	private readonly _onDidPaneCompositeClose = this._register(new Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>());
	readonly onDidPaneCompositeClose = this._onDidPaneCompositeClose.event;

	private readonly paneCompositeParts = new Map<ViewContainerLocation, IPaneCompositePart>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentWorkbenchLayoutService private readonly layoutService: IAgentWorkbenchLayoutService,
	) {
		super();
	}

	initialize(): void {
		// Eagerly instantiate all 3 pane composite parts so they register themselves with layoutService
		this.getPartByLocation(ViewContainerLocation.Sidebar);
		this.getPartByLocation(ViewContainerLocation.Panel);
		this.getPartByLocation(ViewContainerLocation.AuxiliaryBar);
	}

	private registerPart(location: ViewContainerLocation, part: IPaneCompositePart): void {
		this.paneCompositeParts.set(location, part);
		this._register(part.onDidPaneCompositeOpen(composite => this._onDidPaneCompositeOpen.fire({ composite, viewContainerLocation: location })));
		this._register(part.onDidPaneCompositeClose(composite => this._onDidPaneCompositeClose.fire({ composite, viewContainerLocation: location })));
	}

	getRegistryId(viewContainerLocation: ViewContainerLocation): string {
		switch (viewContainerLocation) {
			case ViewContainerLocation.Panel:
				return Extensions.Panels;
			case ViewContainerLocation.Sidebar:
				return Extensions.Viewlets;
			case ViewContainerLocation.AuxiliaryBar:
				return Extensions.Auxiliary;
			default:
				return '';
		}
	}

	getPartId(viewContainerLocation: ViewContainerLocation): SINGLE_WINDOW_PARTS {
		switch (viewContainerLocation) {
			case ViewContainerLocation.Panel:
				return Parts.PANEL_PART;
			case ViewContainerLocation.Sidebar:
				return Parts.SIDEBAR_PART;
			case ViewContainerLocation.AuxiliaryBar:
				return Parts.AUXILIARYBAR_PART;
			default:
				return Parts.PANEL_PART;
		}
	}

	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<IPaneComposite | undefined> {
		return this.getPartByLocation(viewContainerLocation).openPaneComposite(id, focus);
	}

	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation).getActivePaneComposite();
	}

	getPaneComposite(id: string, viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor | undefined {
		return this.getPartByLocation(viewContainerLocation).getPaneComposite(id);
	}

	getPaneComposites(viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor[] {
		return this.getPartByLocation(viewContainerLocation).getPaneComposites();
	}

	getPinnedPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPinnedPaneCompositeIds();
	}

	getVisiblePaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getVisiblePaneCompositeIds();
	}

	getPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPaneCompositeIds();
	}

	getProgressIndicator(id: string, viewContainerLocation: ViewContainerLocation): IProgressIndicator | undefined {
		return this.getPartByLocation(viewContainerLocation).getProgressIndicator(id);
	}

	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation).hideActivePaneComposite();
	}

	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation).getLastActivePaneCompositeId();
	}

	private getPartByLocation(viewContainerLocation: ViewContainerLocation): IPaneCompositePart {
		let part = this.paneCompositeParts.get(viewContainerLocation);
		if (!part) {
			part = this.createPart(viewContainerLocation);
			this.registerPart(viewContainerLocation, part);
		}
		return part;
	}

	private createPart(viewContainerLocation: ViewContainerLocation): IPaneCompositePart {
		const { width } = getClientArea(mainWindow.document.body);
		const isPhoneLayout = width < 640;

		switch (viewContainerLocation) {
			case ViewContainerLocation.Panel:
				return this.instantiationService.createInstance(isPhoneLayout ? MobilePanelPart : PanelPart);
			case ViewContainerLocation.Sidebar:
				return this.instantiationService.createInstance(isPhoneLayout ? MobileSidebarPart : SidebarPart);
			case ViewContainerLocation.AuxiliaryBar:
				return this.layoutService.isSinglePaneLayoutEnabled
					? (this.instantiationService.invokeFunction(accessor => accessor.get(IEditorGroupsService)).mainPart as SinglePaneMainEditorPart).auxiliaryBar
					: this.instantiationService.createInstance(isPhoneLayout ? MobileAuxiliaryBarPart : AuxiliaryBarPart);
			default:
				throw new Error(`Unknown view container location: ${viewContainerLocation}`);
		}
	}

}

registerSingleton(IPaneCompositePartService, AgenticPaneCompositePartService, InstantiationType.Delayed);
