import { render } from 'preact';
import './styles/music.css';
import { App } from './app/App';
import { startRouter } from './app/router';
import { initServices } from './app/services';

function boot(): void {
  const root = document.getElementById('app')!;
  try {
    initServices();
    startRouter();
    root.replaceChildren();
    render(<App />, root);
  } catch (error) {
    console.error('[music] failed to start', error);
    root.replaceChildren();
    const box = document.createElement('div');
    box.className = 'm-empty is-bad m-boot-error';
    const pre = document.createElement('pre');
    pre.className = 'ascii';
    pre.setAttribute('aria-hidden', 'true');
    pre.textContent = ['   ________', '  /        \\', ' /  ><  ><  \\', ' \\   ____   /', '  \\________/'].join('\n');
    const p = document.createElement('p');
    p.textContent = '> music couldn’t start. reload the page.';
    const b = document.createElement('button');
    b.textContent = 'reload';
    b.className = 'pill';
    b.onclick = () => location.reload();
    box.append(pre, p, b);
    root.appendChild(box);
  }
}

boot();
