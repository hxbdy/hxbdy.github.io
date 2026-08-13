/*
 * tex-page.js
 * kaitou/ 配下の生成済み解答例ページ用。
 * ページ側で window.__TEX_MACROS に元 .tex のプリアンブル由来のマクロ定義を入れておくと、
 * それを使って MathJax を初期化する。
 * ページの生成手順は tools/README.md を参照。
 */
(function () {
  'use strict';

  var MATHJAX_CDN = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';

  // JS が動いている間だけ .tex-math を組版待ちにする（no-js は tex-page.css で常時表示）
  document.documentElement.classList.remove('no-js');

  window.MathJax = {
    tex: {
      macros: window.__TEX_MACROS || {},
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

  var s = document.createElement('script');
  s.src = MATHJAX_CDN;
  s.async = true;
  s.id = 'MathJax-script';
  s.onerror = function () {
    // 組版できなくても TeX ソースのまま読めるようにする
    document.body.classList.add('is-typeset');
  };
  document.head.appendChild(s);
})();
