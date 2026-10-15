// POSIX-style globs over repo-relative paths, with `**` crossing directories.
// A pattern is anchored at the repo root. `*`, `?` and `[...]` stay within one path segment; `**` as a whole segment
// matches zero or more segments. Dotfiles are not special: a gate that runs when it need not is cheaper than one
// skipped when it should have run.

const cache = new Map();

export function globToRegExp(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const atStart = i === 0 || pattern[i - 1] === '/';
      const atEnd = i + 2 === pattern.length || pattern[i + 2] === '/';
      if (atStart && atEnd) {
        if (i + 2 === pattern.length) {
          out += '.*'; // trailing `**`: everything below
          i += 2;
        } else {
          out += '(?:.*/)?'; // `**/`: zero or more directories
          i += 3;
        }
        continue;
      }
      out += '[^/]*'; // `**` inside a segment acts like `*`
      i += 2;
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
      } else {
        let body = pattern.slice(i + 1, close);
        if (body[0] === '!') body = '^/' + body.slice(1);
        out += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = close;
      }
    } else {
      out += c.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
    i += 1;
  }
  return new RegExp('^' + out + '$');
}

export function globMatch(pattern, path) {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchesAny(path, patterns) {
  return patterns.some((p) => globMatch(p, path));
}
