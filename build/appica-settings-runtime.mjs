import { build } from 'esbuild';

await build({
	stdin: {
		contents: `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@appica/ui-react/button';
import { Input } from '@appica/ui-react/input';
import { Loader } from '@appica/ui-react/loader';
import { SettingsSpark, Settings, Logout } from '@appica/icons-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from '@appica/ui-react/dropdown-menu';

export function mountAppicaButton(container: HTMLElement, label: string, onClick?: (event: MouseEvent) => void, options: { variant?: string; size?: string; className?: string; ariaLabel?: string } = {}) {
	const root = createRoot(container);
	root.render(React.createElement(Button, { className: options.className ?? 'settings-home-appica-button', variant: options.variant ?? 'outline', size: options.size ?? 'sm', 'aria-label': options.ariaLabel, onClick }, label));
	return () => root.unmount();
}

export function mountAppicaInput(container: HTMLElement, value: string, placeholder: string, ariaLabel: string, onChange: (value: string) => void) {
	const root = createRoot(container);
	root.render(React.createElement(Input, { className: 'settings-home-appica-input', defaultValue: value, placeholder, 'aria-label': ariaLabel, inputSize: 'sm', onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value) }));
	return () => root.unmount();
}

export function mountAppicaSettingsSpark(container: HTMLElement) {
	const root = createRoot(container);
	root.render(React.createElement(SettingsSpark, { className: 'settings-home-appica-icon', 'aria-hidden': true }));
	return () => root.unmount();
}

export function mountAppicaLoader(container: HTMLElement) {
	const root = createRoot(container);
	root.render(React.createElement(Loader, { className: 'text-6xl' }));
	return () => root.unmount();
}

export function mountAppicaAccountMenu(container: HTMLElement, account: { name: string; email?: string }, onAction?: (action: string) => void) {
	const root = createRoot(container);

	function getInitials(name: string): string {
		return (name || '')
			.trim()
			.split(/\\s+/)
			.slice(0, 2)
			.map(p => p[0])
			.join('')
			.toUpperCase() || 'A';
	}

	root.render(
		React.createElement(DropdownMenu, null,
			React.createElement(DropdownMenuTrigger, {
				className: 'appica-sidebar-account-trigger-wrapper'
			},
				React.createElement('div', { className: 'appica-sidebar-account-trigger-content' },
					React.createElement('div', { className: 'appica-sidebar-account-avatar' }, getInitials(account.name)),
					React.createElement('div', { className: 'appica-sidebar-account-name' }, account.name)
				)
			),
			React.createElement(DropdownMenuContent, { side: 'top', align: 'start', sideOffset: 8, className: 'appica-account-popup-content' },
				React.createElement('div', { className: 'appica-account-popup-header' },
					React.createElement('div', { className: 'appica-sidebar-account-avatar' }, getInitials(account.name)),
					React.createElement('div', { className: 'appica-account-popup-header-info' },
						React.createElement('div', { className: 'appica-account-popup-header-name' }, account.name),
						account.email ? React.createElement('div', { className: 'appica-account-popup-header-email' }, account.email) : null
					)
				),
				React.createElement(DropdownMenuSeparator, null),
				React.createElement(DropdownMenuGroup, null,
					React.createElement(DropdownMenuItem, { onClick: () => onAction?.('settings') },
						React.createElement(Settings, { 'data-icon': 'start' }),
						'Paramètres'
					)
				),
				React.createElement(DropdownMenuSeparator, null),
				React.createElement(DropdownMenuItem, { onClick: () => onAction?.('sign-out') },
					React.createElement(Logout, { 'data-icon': 'start' }),
					'Se déconnecter'
				)
			)
		)
	);
	return () => root.unmount();
}
`,
		resolveDir: process.cwd(),
		sourcefile: 'appica-settings-runtime.ts',
		loader: 'tsx'
	},
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	legalComments: 'none',
	outfile: 'src/vs/workbench/contrib/preferences/browser/appicaRuntime.js'
});

await build({
	entryPoints: ['build/appica-auth-page.tsx'],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	legalComments: 'none',
	outfile: 'src/vs/workbench/contrib/preferences/browser/media/appicaAuthPage.js'
});

await build({
	stdin: {
		contents: `@import '@appica/ui-react/styles.css';
@source inline("text-6xl text-primary text-primary-soft text-[2.5rem] inline-flex shrink-0 items-center justify-center align-middle size-[1em] h-[0.2em]! w-[1.4em]!");`,
		resolveDir: process.cwd(),
		sourcefile: 'appica-runtime.css',
		loader: 'css'
	},
	bundle: true,
	conditions: ['style'],
	outfile: 'src/vs/workbench/contrib/preferences/browser/media/appicaRuntime.css'
});
