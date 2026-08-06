/*
 * tex-viewer.js
 * math_pdf_file/ 以下の .tex ファイルを読み込み、MathJax でブラウザ上に描画する。
 * 使い方: tex.html?file=<サイトルートからの相対パス>
 */
(function () {
  'use strict';

  var MATHJAX_CDN = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';

  /* ------------------------------------------------------------------
   *  低レベルユーティリティ
   * ------------------------------------------------------------------ */

  // src[open] の '{' に対応する '}' の位置を返す（見つからなければ -1）
  function matchBrace(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      var c = src.charAt(i);
      if (c === '\\') { i++; continue; }
      if (c === '{') { depth++; }
      else if (c === '}') { depth--; if (depth === 0) { return i; } }
    }
    return -1;
  }

  // 位置 i 以降の「{...}」を読み取る。{ body: 中身, next: 次の位置 }
  function readGroup(src, i) {
    while (i < src.length && /\s/.test(src.charAt(i))) { i++; }
    if (src.charAt(i) !== '{') { return null; }
    var end = matchBrace(src, i);
    if (end < 0) { return null; }
    return { body: src.slice(i + 1, end), next: end + 1 };
  }

  // % 以降のコメントを削除する（\% は残す）
  function stripComments(src) {
    return src.split('\n').map(function (line) {
      var out = '';
      for (var i = 0; i < line.length; i++) {
        var c = line.charAt(i);
        if (c === '\\') { out += line.substr(i, 2); i++; continue; }
        if (c === '%') { break; }
        out += c;
      }
      return out;
    }).join('\n');
  }

  // \name{...} を引数ごと削除する
  function removeCmdArg(src, name) {
    var re = new RegExp('\\\\' + name + '\\*?\\s*', 'g');
    var out = '';
    var pos = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      var g = readGroup(src, m.index + m[0].length);
      out += src.slice(pos, m.index);
      pos = g ? g.next : m.index + m[0].length;
      re.lastIndex = pos;
    }
    return out + src.slice(pos);
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    return node;
  }

  /* ------------------------------------------------------------------
   *  プリアンブルのマクロ定義を MathJax 用に変換
   * ------------------------------------------------------------------ */

  // \def / \newcommand / \renewcommand / \DeclareMathOperator を拾い、
  // MathJax の tex.macros 形式（"body" もしくは ["body", 引数の数]）に変換する。
  function parseMacros(preamble) {
    var macros = {};
    var re = /\\(def|newcommand|renewcommand|providecommand|DeclareMathOperator)\b\*?/g;
    var m;
    while ((m = re.exec(preamble)) !== null) {
      var kind = m[1];
      var i = m.index + m[0].length;
      var name = null;
      var nargs = 0;
      var body = null;

      if (kind === 'def') {
        var nm = /^\s*\\([a-zA-Z]+)/.exec(preamble.slice(i));
        if (!nm) { continue; }
        name = nm[1];
        i += nm[0].length;
        // #1#2... のみ対応（区切り記号つきの \def は無視）
        var pm = /^((?:#\d)*)/.exec(preamble.slice(i));
        nargs = pm[1].length / 2;
        i += pm[1].length;
        var gd = readGroup(preamble, i);
        if (!gd) { continue; }
        body = gd.body;
        re.lastIndex = gd.next;
      } else if (kind === 'DeclareMathOperator') {
        var g1 = readGroup(preamble, i);
        if (!g1) { continue; }
        var g2 = readGroup(preamble, g1.next);
        if (!g2) { continue; }
        var opName = /\\([a-zA-Z]+)/.exec(g1.body);
        if (!opName) { continue; }
        name = opName[1];
        body = '\\operatorname{' + g2.body + '}';
        re.lastIndex = g2.next;
      } else {
        // \newcommand{\foo}[n]{...} と \newcommand\foo[n]{...} の両方に対応
        var cname = null;
        var ga = readGroup(preamble, i);
        if (ga) {
          cname = /\\([a-zA-Z]+)/.exec(ga.body);
          i = ga.next;
        } else {
          var direct = /^\s*\\([a-zA-Z]+)/.exec(preamble.slice(i));
          if (direct) { cname = [null, direct[1]]; i += direct[0].length; }
        }
        if (!cname) { continue; }
        name = cname[1];
        var am = /^\s*\[(\d+)\]/.exec(preamble.slice(i));
        if (am) { nargs = parseInt(am[1], 10); i += am[0].length; }
        var gb = readGroup(preamble, i);
        if (!gb) { continue; }
        body = gb.body;
        re.lastIndex = gb.next;
      }

      macros[name] = nargs > 0 ? [body, nargs] : body;
    }
    return macros;
  }

  /* ------------------------------------------------------------------
   *  本文のブロック分割
   * ------------------------------------------------------------------ */

  var MATH_ENVS = {
    'align': 1, 'align*': 1, 'aligned': 1,
    'equation': 1, 'equation*': 1,
    'gather': 1, 'gather*': 1,
    'eqnarray': 1, 'eqnarray*': 1,
    'multline': 1, 'multline*': 1,
    'displaymath': 1
  };

  // \begin{env} の対応する \end{env} を入れ子を考慮して探す
  function findEnvEnd(src, env, from) {
    var esc = env.replace(/([*+?^${}()|[\]\\])/g, '\\$1');
    var re = new RegExp('\\\\(begin|end)\\s*\\{' + esc + '\\}', 'g');
    re.lastIndex = from;
    var depth = 1;
    var m;
    while ((m = re.exec(src)) !== null) {
      depth += (m[1] === 'begin') ? 1 : -1;
      if (depth === 0) { return { start: m.index, next: m.index + m[0].length }; }
    }
    return { start: src.length, next: src.length };
  }

  function pushText(blocks, raw) {
    if (/^\s*$/.test(raw)) { return; }
    blocks.push({ type: 'text', tex: raw.trim() });
  }

  function parseBody(body) {
    var blocks = [];
    var re = /\\(paragraph|subparagraph|clearpage|newpage|begin)\b\*?/g;
    var pos = 0;
    var m;
    while ((m = re.exec(body)) !== null) {
      if (m.index < pos) { continue; }
      if (m.index > pos) { pushText(blocks, body.slice(pos, m.index)); }

      var kind = m[1];
      var after = m.index + m[0].length;

      if (kind === 'clearpage' || kind === 'newpage') {
        blocks.push({ type: 'break' });
        pos = after;
      } else if (kind === 'paragraph' || kind === 'subparagraph') {
        var gh = readGroup(body, after);
        if (!gh) { pos = after; }
        else {
          blocks.push({ type: 'heading', tex: gh.body });
          pos = gh.next;
        }
      } else {
        var ge = readGroup(body, after);
        if (!ge) { pos = after; }
        else {
          var env = ge.body.trim();
          var close = findEnvEnd(body, env, ge.next);
          var inner = body.slice(ge.next, close.start);
          pos = close.next;
          if (env === 'center') {
            blocks.push({ type: 'center', tex: inner });
          } else if (env === 'flushleft' || env === 'flushright') {
            blocks.push({ type: 'flush', align: env, tex: inner });
          } else if (MATH_ENVS[env]) {
            blocks.push({ type: 'math', env: env, tex: inner });
          } else {
            // 未知の環境は中身をそのまま本文として扱う
            pushText(blocks, inner);
          }
        }
      }
      re.lastIndex = pos;
    }
    pushText(blocks, body.slice(pos));
    return blocks;
  }

  /* ------------------------------------------------------------------
   *  数式ブロックの整形
   * ------------------------------------------------------------------ */

  // \intertext{...} で数式ブロックを分割する
  function splitIntertext(inner) {
    var parts = [];
    var re = /\\(?:short)?intertext\s*\{/g;
    var pos = 0;
    var m;
    while ((m = re.exec(inner)) !== null) {
      var open = m.index + m[0].length - 1;
      var end = matchBrace(inner, open);
      if (end < 0) { break; }
      parts.push({ kind: 'math', tex: inner.slice(pos, m.index) });
      parts.push({ kind: 'text', tex: inner.slice(open + 1, end) });
      pos = end + 1;
      re.lastIndex = pos;
    }
    parts.push({ kind: 'math', tex: inner.slice(pos) });
    return parts;
  }

  // MathJax が解釈できない指定を落とし、前後の余分な改行を削る
  function cleanMath(tex) {
    var t = removeCmdArg(tex, 'vspace');
    t = removeCmdArg(t, 'hspace');
    t = t.replace(/\\(?:raggedbottom|allowdisplaybreaks|noindent)\b/g, '');
    t = t.trim();
    // 先頭の空行（& は桁揃えの意味を持つので残す）
    t = t.replace(/^(?:\s*(?:\\\\(?:\s*\[[^\]]*\])?|\\nr|\\ret|\\notag))+/, '');
    // 末尾の空行
    t = t.replace(/(?:\s*(?:\\\\(?:\s*\[[^\]]*\])?|\\nr|\\ret|\\notag))+\s*$/, '');
    return t.trim();
  }

  /* ------------------------------------------------------------------
   *  テキストの描画
   * ------------------------------------------------------------------ */

  var INLINE_TAGS = {
    textbf: 'strong', bf: 'strong', textsc: 'span',
    emph: 'em', textit: 'em', it: 'em',
    underline: 'u', textrm: 'span', textsf: 'span', text: 'span', mbox: 'span'
  };

  // 数式を含まない TeX 断片を DOM に追加する
  function appendPlain(src, parent) {
    var buf = '';
    function flush() {
      if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ''; }
    }
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      if (c === '\\') {
        if (src.charAt(i + 1) === '\\') {
          flush();
          parent.appendChild(el('br'));
          i += 2;
          // \\[2pt] のような行送り指定は読み飛ばす
          var opt = /^\s*\[[^\]]*\]/.exec(src.slice(i));
          if (opt) { i += opt[0].length; }
          continue;
        }
        var cmd = /^\\([a-zA-Z]+)\s*/.exec(src.slice(i));
        if (cmd) {
          var name = cmd[1];
          var g = readGroup(src, i + cmd[0].length);
          if (g) {
            flush();
            if (INLINE_TAGS[name]) {
              var node = el(INLINE_TAGS[name]);
              appendPlain(g.body, node);
              parent.appendChild(node);
            } else {
              // 未知のコマンドは中身だけ残す
              appendPlain(g.body, parent);
            }
            i = g.next;
            continue;
          }
          if (name === 'quad') { buf += '　'; i += cmd[0].length; continue; }
          if (name === 'qquad') { buf += '　　'; i += cmd[0].length; continue; }
          i += cmd[0].length;
          continue;
        }
        // \ + 記号（\ , \%, \& など）はその記号を出す
        buf += src.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === '{' || c === '}') { i++; continue; }
      if (c === '~') { buf += ' '; i++; continue; }
      buf += c;
      i++;
    }
    flush();
  }

  // $...$ をインライン数式として保持しつつテキストを描画する
  function renderInline(tex, parent) {
    var re = /\$([^$]*)\$/g;
    var pos = 0;
    var m;
    while ((m = re.exec(tex)) !== null) {
      appendPlain(tex.slice(pos, m.index), parent);
      parent.appendChild(document.createTextNode('\\(' + m[1] + '\\)'));
      pos = re.lastIndex;
    }
    appendPlain(tex.slice(pos), parent);
  }

  // 見出し等に使うプレーンテキストを取り出す
  function plainText(tex) {
    var probe = el('div');
    renderInline(tex, probe);
    return probe.textContent.replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------
   *  ブロックの描画
   * ------------------------------------------------------------------ */

  function renderMathBlock(block, root) {
    var parts = splitIntertext(block.tex);
    var rendered = 0;
    parts.forEach(function (part) {
      if (part.kind === 'text') {
        var p = el('p', 'tex-intertext');
        renderInline(part.tex.trim(), p);
        root.appendChild(p);
        rendered++;
        return;
      }
      var math = cleanMath(part.tex);
      if (!math) { return; }
      var div = el('div', 'tex-math');
      div.appendChild(document.createTextNode(
        '\\begin{' + block.env + '}\n' + math + '\n\\end{' + block.env + '}'
      ));
      root.appendChild(div);
      rendered++;
    });
    if (rendered === 0) {
      // 解答が未記入の \begin{align*}\end{align*}
      var empty = el('p', 'tex-empty');
      empty.textContent = '（解答未記入）';
      root.appendChild(empty);
    }
  }

  function renderBlocks(blocks, root) {
    blocks.forEach(function (block) {
      if (block.skip) { return; }
      switch (block.type) {
        case 'break':
          root.appendChild(el('hr', 'tex-pagebreak'));
          break;
        case 'flush': {
          var f = el('p', 'tex-source-line');
          renderInline(block.tex.replace(/\\\\\s*$/, '').trim(), f);
          root.appendChild(f);
          break;
        }
        case 'center': {
          var c = el('div', 'tex-heading');
          renderInline(block.tex.replace(/(\\\\\s*)+$/, '').trim(), c);
          root.appendChild(c);
          break;
        }
        case 'heading': {
          var h = el('h2', 'tex-number');
          renderInline(block.tex, h);
          root.appendChild(h);
          break;
        }
        case 'math':
          renderMathBlock(block, root);
          break;
        case 'text': {
          var t = el('p', 'tex-text');
          renderInline(block.tex, t);
          root.appendChild(t);
          break;
        }
      }
    });
  }

  /* ------------------------------------------------------------------
   *  ファイルの取得とページ組み立て
   * ------------------------------------------------------------------ */

  // ?file= に渡せるのはサイト内の .tex ファイルのみ
  function validatePath(path) {
    if (!path) { return '?file= に .tex ファイルのパスを指定してください。'; }
    if (!/\.tex$/i.test(path)) { return '.tex ファイル以外は表示できません。'; }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.indexOf('//') === 0) {
      return 'サイト外のファイルは表示できません。';
    }
    // URL パーサは \ を / と同じに扱うので、どちらの区切りでも上位に遡れないようにする
    if (path.indexOf('..') >= 0 || path.indexOf('\\') >= 0) { return '不正なパスです。'; }
    return null;
  }

  function showError(title, detail) {
    var box = document.getElementById('tex-body');
    box.textContent = '';
    var h = el('h2', 'tex-error-title');
    h.textContent = title;
    box.appendChild(h);
    if (detail) {
      var p = el('p', 'tex-error-detail');
      p.textContent = detail;
      box.appendChild(p);
    }
  }

  function loadMathJax(macros) {
    window.MathJax = {
      tex: {
        macros: macros,
        inlineMath: [['\\(', '\\)']],
        displayMath: [['\\[', '\\]'], ['$$', '$$']],
        processEnvironments: true,
        processEscapes: false,
        tags: 'none'
      },
      chtml: {
        // 元の .tex が fleqn 指定なので数式は左寄せにする
        displayAlign: 'left',
        displayIndent: '1em'
      },
      options: {
        enableMenu: true,
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      },
      startup: {
        pageReady: function () {
          return window.MathJax.startup.defaultPageReady().then(function () {
            document.body.classList.add('is-typeset');
          });
        }
      }
    };
    var s = el('script');
    s.src = MATHJAX_CDN;
    s.async = true;
    s.id = 'MathJax-script';
    s.onerror = function () {
      document.body.classList.add('is-typeset');
      var note = el('p', 'tex-error-detail');
      note.textContent = 'MathJax の読み込みに失敗しました。数式は TeX のソースのまま表示されます。';
      document.getElementById('tex-body').insertBefore(
        note, document.getElementById('tex-body').firstChild
      );
    };
    document.head.appendChild(s);
  }

  function render(source) {
    var src = stripComments(source);

    var begin = src.indexOf('\\begin{document}');
    var preamble = begin >= 0 ? src.slice(0, begin) : '';
    var rest = begin >= 0 ? src.slice(begin + '\\begin{document}'.length) : src;
    var end = rest.indexOf('\\end{document}');
    var body = end >= 0 ? rest.slice(0, end) : rest;

    var blocks = parseBody(body);

    // 書名（\begin{flushleft}）は見出し欄に出すので本文からは省く
    var bookName = '';
    var heading = '';
    for (var i = 0; i < blocks.length; i++) {
      if (!bookName && blocks[i].type === 'flush') {
        bookName = plainText(blocks[i].tex);
        blocks[i].skip = true;
      }
      if (!heading && blocks[i].type === 'center') {
        heading = plainText(blocks[i].tex);
      }
      if (bookName && heading) { break; }
    }

    var box = document.getElementById('tex-body');
    box.textContent = '';
    renderBlocks(blocks, box);

    if (bookName || heading) {
      document.getElementById('tex-title').textContent = bookName || heading;
      document.title = (heading ? heading + '｜' : '') + 'とどろき英数塾';
    }

    loadMathJax(parseMacros(preamble));
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var path = params.get('file');

    var invalid = validatePath(path);
    if (invalid) {
      showError('ファイルを表示できません', invalid);
      return;
    }

    fetch(path, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      return res.text();
    }).then(function (text) {
      render(text);
    }).catch(function (err) {
      var detail = path + ' を読み込めませんでした（' + err.message + '）。';
      if (window.location.protocol === 'file:') {
        detail += ' ローカルで確認する場合は、file:// ではなく HTTP サーバー'
          + '（例: npx serve、python -m http.server）経由で開いてください。';
      }
      showError('ファイルを読み込めませんでした', detail);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
