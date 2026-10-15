// Globs over repo-relative paths, with `**` crossing directories.
// A pattern is anchored at the repo root. `*` and `?` stay within one path segment; `**` as a whole segment matches
// zero or more segments. Dotfiles are not special: a gate that runs when it need not is cheaper than one skipped
// when it should have run. Every other character is literal.
//
// Constructs other glob dialects give meaning to (bracket expressions, backslash escapes, braces, leading `!`) are not
// implemented: globProblem names them, and the config refuses such a pattern, so none can silently fail to select.

const cache = new Map();

// Why a pattern is refused, or null when globMatch implements everything in it.
export function globProblem(pattern) {
  if (pattern === '') return 'is empty';
  if (/[[\]]/.test(pattern)) return 'uses bracket expressions ([...]), which are not supported; list the paths or use ? and *';
  if (pattern.includes('\\')) return 'uses backslash escapes, which are not supported';
  if (/[{}]/.test(pattern)) return 'uses braces ({a,b}), which are not supported; list each pattern separately';
  if (pattern.startsWith('!')) return 'uses negation (leading !), which is not supported';
  if (pattern.startsWith('/')) return 'has a leading "/"; patterns are relative to the repo root already';
  return null;
}

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
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^$(){}|[\]\\/]/g, '\\$&');
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
