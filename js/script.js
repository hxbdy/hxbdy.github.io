document.addEventListener("DOMContentLoaded", function () {
    // ボタン要素を取得
    var hamburgerButton = document.getElementById("js-hamburger");
    
    // ボタンがクリックされたときの処理を定義
    hamburgerButton.addEventListener("click", function () {
    // body要素にクラス "is-drawerActive" を追加
        document.body.classList.toggle("is-drawerActive");
    });

    const menu = document.querySelector('.p-header__menu-list');
    const menuItems = menu.querySelectorAll('a');

    menuItems.forEach(function(item) {
        item.addEventListener('click', function() {
            // メニューがクリックされたら、メニューを閉じる
            document.body.classList.toggle("is-drawerActive");
        });
    });
});        