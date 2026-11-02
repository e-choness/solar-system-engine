import { mount } from 'svelte';
import App from './App.svelte';
import { MOBILE } from './engine/device.ts';
import { app, audio, engine } from './ui/state.svelte.ts';
import './ui/global.css';

// iOS ignores `user-scalable=no`: a pinch that starts on a panel would zoom the whole page.
if (MOBILE) document.addEventListener('gesturestart', (e) => e.preventDefault());

// Scripted screenshots (scripts/smoke.mjs, scripts/media-kit.mjs) drive the engine through this handle.
if (import.meta.env.DEV) Object.assign(window, { __solar: { app, audio, engine } });

export default mount(App, { target: document.getElementById('app')! });
