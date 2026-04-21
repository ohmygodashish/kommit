import { spawn } from 'child_process';

function spawnClipboard(cmd, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}`));
      } else {
        resolve();
      }
    });

    child.stdin.write(text, 'utf8');
    child.stdin.end();
  });
}

export async function copyToClipboard(text) {
  const platform = process.platform;

  if (platform === 'darwin') {
    return spawnClipboard('pbcopy', [], text);
  }

  if (platform === 'win32') {
    return spawnClipboard('clip.exe', [], text);
  }

  // Linux — try xclip, then xsel, then wl-copy
  const errors = [];

  try {
    return await spawnClipboard('xclip', ['-selection', 'clipboard'], text);
  } catch (err) {
    if (err.code === 'ENOENT') {
      errors.push('xclip not found');
    } else {
      throw err;
    }
  }

  try {
    return await spawnClipboard('xsel', ['--clipboard', '--input'], text);
  } catch (err) {
    if (err.code === 'ENOENT') {
      errors.push('xsel not found');
    } else {
      throw err;
    }
  }

  try {
    return await spawnClipboard('wl-copy', [], text);
  } catch (err) {
    if (err.code === 'ENOENT') {
      errors.push('wl-copy not found');
    } else {
      throw err;
    }
  }

  throw new Error(
    'Clipboard not available. Install one of: xclip, xsel, or wl-clipboard.' +
    '\n  e.g., sudo apt install xclip'
  );
}
