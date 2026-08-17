import { IDisposable } from '../../../common/lifecycle.js';
import './pixelSpinner.css';

export interface IPixelSpinnerOptions {
	/**
	 * Accessible label for the spinner. When provided, the spinner is given
	 * `role="status"` and `aria-label` so screen readers announce a busy state.
	 * When omitted (the default), the spinner is purely decorative and is marked
	 * `aria-hidden="true"` — appropriate when a surrounding element already
	 * conveys the busy state.
	 */
	readonly ariaLabel?: string;

	/**
	 * Visual variant of the spinner.
	 *  - `'grid'` (default): six dots in a 2×3 grid that cascade vertically.
	 *  - `'ring'`: six dots arranged in a circle with a highlight that orbits the ring.
	 */
	readonly variant?: 'grid' | 'ring';
}

export interface IPixelSpinner extends IDisposable {
	readonly element: HTMLElement;
}

/**
 * Creates a modern circular SVG spinner (matching @appica/ui-react/spinner).
 * Color is driven by `currentColor`.
 */
export function createPixelSpinner(parent?: HTMLElement, options?: IPixelSpinnerOptions): IPixelSpinner {
	const container = document.createElement('span');
	container.className = 'monaco-pixel-spinner appica-spinner';
	if (options?.ariaLabel) {
		container.setAttribute('role', 'status');
		container.setAttribute('aria-label', options.ariaLabel);
	} else {
		container.setAttribute('aria-hidden', 'true');
	}

	const svgNamespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(svgNamespace, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.classList.add('appica-spinner-svg');

	const circle = document.createElementNS(svgNamespace, 'circle');
	circle.setAttribute('cx', '12');
	circle.setAttribute('cy', '12');
	circle.setAttribute('r', '10');
	circle.setAttribute('stroke', 'currentColor');
	circle.setAttribute('stroke-width', '3.5');
	circle.setAttribute('stroke-opacity', '0.25');
	circle.setAttribute('fill', 'none');
	svg.appendChild(circle);

	const path = document.createElementNS(svgNamespace, 'path');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('d', 'M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z');
	svg.appendChild(path);

	container.appendChild(svg);
	parent?.appendChild(container);
	return {
		element: container,
		dispose: () => {
			container.remove();
		},
	};
}
