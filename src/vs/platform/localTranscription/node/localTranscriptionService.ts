/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { join } from '../../../base/common/path.js';
import { cpus } from 'os';
import {
	DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
	ILocalTranscriptionModelImportResult,
	ILocalTranscriptionModelStatus,
	ILocalTranscriptionResult,
	ILocalTranscriptionService,
	LocalTranscriptionModelState,
} from '../common/localTranscription.js';

const SAMPLE_RATE = 16000;
const WHISPER_MODEL = DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
const MAX_THREADS = Math.min(4, Math.max(1, cpus().length - 2));
const MAX_CHUNK_SAMPLES = SAMPLE_RATE * 12;
const HARD_SPLIT_OVERLAP_SAMPLES = SAMPLE_RATE * 0.4;
const VAD_FRAME_SAMPLES = SAMPLE_RATE * 0.02;
const VAD_HANGOVER_FRAMES = 18;

type WhisperResult = { readonly text?: string } | string;
type WhisperPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<WhisperResult>;
type ModelDownloadProgress = { readonly status?: string; readonly file?: string; readonly loaded?: number; readonly total?: number; readonly progress?: number };

/**
 * Local transcription backed by Hugging Face Transformers.js and ONNX Runtime.
 * The model is downloaded into the per-user cache on first use, then inference
 * runs in this utility process without sending microphone audio to a server.
 */
export class LocalTranscriptionService extends Disposable implements ILocalTranscriptionService {
	declare readonly _serviceBrand: undefined;

	readonly isSupported = true;
	private readonly _onDidChangeModelStatus = this._register(new Emitter<ILocalTranscriptionModelStatus>());
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus> = this._onDidChangeModelStatus.event;
	private readonly _onDidTranscribe = this._register(new Emitter<ILocalTranscriptionResult>());
	readonly onDidTranscribe: Event<ILocalTranscriptionResult> = this._onDidTranscribe.event;

	private _status: ILocalTranscriptionModelStatus = { state: LocalTranscriptionModelState.Idle };
	private _pipeline: WhisperPipeline | undefined;
	private _pipelinePromise: Promise<WhisperPipeline> | undefined;
	private _sessionActive = false;
	private _generation = 0;
	private _pendingAudio: Uint8Array[] = [];
	private _language: string | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this._sessionActive = false;
			this._pendingAudio = [];
		}));
	}

	async getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		return this._status;
	}

	async prepareModel(options: { cacheDir: string }): Promise<void> {
		if (this._pipeline || this._pipelinePromise) {
			return;
		}
		try {
			await this._ensurePipeline(options.cacheDir);
			// Keep the loaded pipeline resident. Startup work is asynchronous and
			// never blocks the workbench; subsequent microphone presses reuse these
			// weights instead of paying the model-load cost again.
			this._setStatus({ state: LocalTranscriptionModelState.Ready, downloaded: true });
		} catch {
			// The normal microphone path retries and reports the detailed error.
		}
	}

	async importModel(_options: { sourcePath: string; cacheDir: string }): Promise<ILocalTranscriptionModelImportResult> {
		throw new Error('Whisper models are downloaded automatically from Hugging Face on first use.');
	}

	private _setStatus(status: ILocalTranscriptionModelStatus): void {
		this._status = status;
		this._onDidChangeModelStatus.fire(status);
	}

	private async _ensurePipeline(cacheDir: string): Promise<WhisperPipeline> {
		if (this._pipeline) {
			return this._pipeline;
		}
		if (this._pipelinePromise) {
			return this._pipelinePromise;
		}

		this._pipelinePromise = (async () => {
		try {
				this._setStatus({ state: LocalTranscriptionModelState.Downloading, progress: 0, downloadedBytes: 0 });
				const transformers = await import('@huggingface/transformers');
				transformers.env.cacheDir = join(cacheDir, 'huggingface');
				transformers.env.allowRemoteModels = true;
				transformers.env.allowLocalModels = true;
				const files = new Map<string, { loaded: number; total?: number }>();
				// Tiny Q4 minimizes the resident memory footprint for an IDE. Configure ONNX before creating the
				// pipeline so this utility process never consumes every CPU core.
				process.env.OMP_NUM_THREADS = String(MAX_THREADS);
				process.env.ORT_NUM_THREADS = String(MAX_THREADS);
				const runtimeEnvironment = transformers.env as typeof transformers.env & {
					backends?: { onnx?: { wasm?: { numThreads?: number } } };
				};
				if (runtimeEnvironment.backends?.onnx?.wasm) {
					runtimeEnvironment.backends.onnx.wasm.numThreads = MAX_THREADS;
				}
				const transcriber = await transformers.pipeline('automatic-speech-recognition', WHISPER_MODEL, {
					dtype: 'q4',
					device: 'cpu',
					progress_callback: (event: ModelDownloadProgress) => {
						if (event.status !== 'progress') {
							return;
						}
						const key = event.file ?? 'model';
						files.set(key, { loaded: Math.max(0, event.loaded ?? 0), total: event.total });
						const downloadedBytes = [...files.values()].reduce((sum, file) => sum + file.loaded, 0);
						const knownTotals = [...files.values()].filter(file => typeof file.total === 'number');
						const totalBytes = knownTotals.length ? knownTotals.reduce((sum, file) => sum + file.total!, 0) : undefined;
						this._setStatus({
							state: LocalTranscriptionModelState.Downloading,
							progress: totalBytes ? downloadedBytes / totalBytes : event.progress !== undefined ? event.progress / 100 : undefined,
							downloadedBytes,
							totalBytes,
						});
					},
				}) as unknown as WhisperPipeline;
				this._pipeline = transcriber;
				this._setStatus({ state: LocalTranscriptionModelState.Ready, downloaded: true });
				return transcriber;
			} catch (error) {
				this._pipelinePromise = undefined;
				const message = error instanceof Error ? error.message : String(error);
				this._setStatus({ state: LocalTranscriptionModelState.Error, error: message, errorCode: this._classifyError(message) });
				throw error;
			}
		})();
		return this._pipelinePromise;
	}

	private _classifyError(message: string): string {
		const value = message.toLowerCase();
		if (/404|not found|repository/.test(value)) { return 'notFound'; }
		if (/network|fetch|econn|timeout|dns|offline|proxy|certificate/.test(value)) { return 'network'; }
		if (/memory|allocation|enomem/.test(value)) { return 'memory'; }
		return 'unknown';
	}

	async start(options: { cacheDir: string; model?: string; language?: string; proxyUrl?: string; noProxy?: string; proxyStrictSSL?: boolean; proxyAuthorization?: string; runtimeUrlTemplate?: string; runtimeVersion?: string }): Promise<void> {
		this._sessionActive = false;
		this._generation++;
		this._pendingAudio = [];
		this._sessionActive = true;
		this._language = options.language;
		const generation = this._generation;
		await this._ensurePipeline(options.cacheDir);
		if (generation !== this._generation) {
			return;
		}
		this._setStatus({ state: LocalTranscriptionModelState.Ready });
	}

	async pushAudio(chunk: VSBuffer): Promise<void> {
		if (!this._sessionActive) {
			return;
		}
		// The IPC layer already owns a fresh buffer for this message. Retain it
		// directly; copying here only doubles the session's PCM footprint.
		this._pendingAudio.push(chunk.buffer);
	}

	private _toFloat32(chunks: readonly Uint8Array[]): Float32Array {
		const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
		const audio = new Float32Array(Math.floor(length / 2));
		let offset = 0;
		for (const chunk of chunks) {
			for (let index = 0; index + 1 < chunk.length; index += 2) {
				let sample = chunk[index] | (chunk[index + 1] << 8);
				if (sample & 0x8000) { sample -= 0x10000; }
				audio[offset++] = sample / 32768;
			}
		}
		return audio;
	}

	private _speechSegments(audio: Float32Array): Float32Array[] {
		const frameEnergies: number[] = [];
		for (let offset = 0; offset < audio.length; offset += VAD_FRAME_SAMPLES) {
			const end = Math.min(audio.length, offset + VAD_FRAME_SAMPLES);
			let energy = 0;
			for (let index = offset; index < end; index++) {
				energy += audio[index] * audio[index];
			}
			frameEnergies.push(Math.sqrt(energy / Math.max(1, end - offset)));
		}
		if (!frameEnergies.length) {
			return [];
		}
		// Estimate the room noise from a short startup window. Keep this small and
		// local instead of sorting every frame of a long recording. The floor is
		// updated below during quiet periods, so fans and keyboard noise are
		// tracked without swallowing a quiet speaker.
		const calibrationFrames = frameEnergies.slice(0, Math.min(12, frameEnergies.length));
		calibrationFrames.sort((left, right) => left - right);
		let noiseFloor = calibrationFrames[Math.floor(calibrationFrames.length / 2)] ?? 0;
		const segments: Float32Array[] = [];
		let startFrame = -1;
		let silenceFrames = 0;
		for (let frame = 0; frame < frameEnergies.length; frame++) {
			const threshold = Math.max(0.012, noiseFloor * 3.2);
			if (frameEnergies[frame] >= threshold) {
				if (startFrame < 0) {
					startFrame = Math.max(0, frame - 8);
				}
				silenceFrames = 0;
				continue;
			}
			noiseFloor += (frameEnergies[frame] - noiseFloor) * 0.08;
			if (startFrame < 0) {
				continue;
			}
			silenceFrames++;
			if (silenceFrames >= VAD_HANGOVER_FRAMES) {
				const endFrame = Math.min(frameEnergies.length, frame - VAD_HANGOVER_FRAMES + 8);
				if (endFrame > startFrame) {
					segments.push(audio.subarray(startFrame * VAD_FRAME_SAMPLES, Math.min(audio.length, endFrame * VAD_FRAME_SAMPLES)));
				}
				startFrame = -1;
				silenceFrames = 0;
			}
		}
		if (startFrame >= 0) {
			segments.push(audio.subarray(startFrame * VAD_FRAME_SAMPLES));
		}
		return segments;
	}

	private async _transcribeChunks(pipeline: WhisperPipeline, segments: readonly Float32Array[]): Promise<string> {
		const texts: string[] = [];
		for (const segment of segments) {
			for (let offset = 0; offset < segment.length; offset += MAX_CHUNK_SAMPLES - HARD_SPLIT_OVERLAP_SAMPLES) {
				const end = Math.min(segment.length, offset + MAX_CHUNK_SAMPLES);
				const result = await pipeline(segment.subarray(offset, end), {
				sampling_rate: SAMPLE_RATE,
				return_timestamps: false,
				...(this._language ? { generate_kwargs: { language: this._language } } : {}),
				});
				const text = typeof result === 'string' ? result : (result.text ?? '').trim();
				if (text) {
					texts.push(text);
				}
				if (end === segment.length) {
					break;
				}
			}
		}
		return this._mergeOverlappingText(texts);
	}

	private _mergeOverlappingText(parts: readonly string[]): string {
		let result = '';
		for (const part of parts) {
			const words = part.split(/\s+/).filter(Boolean);
			const existing = result.split(/\s+/).filter(Boolean);
			let overlap = 0;
			for (let count = 1; count <= Math.min(8, existing.length, words.length); count++) {
				if (existing.slice(-count).join(' ').toLowerCase() === words.slice(0, count).join(' ').toLowerCase()) {
					overlap = count;
				}
			}
			result = [...existing, ...words.slice(overlap)].join(' ');
		}
		return result.trim();
	}

	async stop(): Promise<string> {
		const generation = this._generation;
		this._sessionActive = false;
		const chunks = this._pendingAudio;
		this._pendingAudio = [];
		if (!chunks.length) {
			return '';
		}

		const pipeline = this._pipeline;
		if (!pipeline || generation !== this._generation) {
			return '';
		}
		this._setStatus({ state: LocalTranscriptionModelState.Loading });
		const speech = this._speechSegments(this._toFloat32(chunks));
		const text = speech.length ? await this._transcribeChunks(pipeline, speech) : '';
		this._setStatus({ state: LocalTranscriptionModelState.Ready });
		this._onDidTranscribe.fire({ text, isFinal: true, finalizedText: text });
		return text;
	}

	async cancel(): Promise<void> {
		this._generation++;
		this._sessionActive = false;
		this._pendingAudio = [];
	}
}
