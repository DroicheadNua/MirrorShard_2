# Linux環境での運用について  

v0.3.0以降、MirrorShard 2のLinuxバイナリの配布を停止しておりましたが、v1.7.0より試験的（experimental）に配布を再開いたします。  

LinuxのGUI環境（特にTauriが依存するWebKitGTK）の仕様に起因する環境依存の不具合が多かったため配布を停止しておりましたが、WebKitGTKのハードウェアアクセラレーション
を無効化することによって、従来正常に起動しなかったNvidia製グラフィックボード搭載機、及びWayland環境でも動作するようになったため配布を再開しました。  

ただし、Linux版は一部の機能に制限があります（後述）。  

また、前作（Electron版）もLinux版を配布しています。  
https://github.com/DroicheadNua/MirrorShard

## 機能制限  

Linux版では、以下の機能は使用できません。  

・マークダウン／HTMLプレビュー  
・SillyTavern連携機能  
・OpenCode連携機能  
・タイプ音  
・スポットライトモード  

## 既知の問題  

開発者によるテスト結果では以下の不具合が発生しています。  

共通：  
背景が半透明のとき、文字の残像が残る場合がある（スクロールアウトなどで再描画すれば正常に戻る。また背景が不透明のときには発生しない）  

MX Linux（X11/Xfce）：  
・インライン入力が機能しないため、Over-the-spot入力になる（変換中の未確定文字列はエディタ上ではなく、IMEの変換ウィンドウ内に表示される）  

Fedora（Wayland/GNOME、仮想環境）：  
・ウィンドウサイズを変更する際、ウィンドウの端にマウスカーソルを持っていってもカーソル形状が変化しない（そのため若干操作しづらいが、サイズ変更自体は可能）  

## 配布形式  

deb・rpm・deb(arm64)のみの配布となっております。それ以外の形式でお使いの場合は、下記の手順でビルドしてください。  

## 利用方法 （ビルド）  

上記の制約を理解した上で、ご自身の環境でMirrorShard 2を利用したい場合は、GitHubのリポジトリからソースコードを取得してビルドを行ってください。  

**必要なもの:**  
*   Rust (Cargo)  
*   Node.js & pnpm  
*   WebKitGTK 開発ライブラリ (Debian系なら `libwebkit2gtk-4.0-dev` 等)  

必要なTauriパッケージ及びRustのインストールにつきましては、下記（Tauri公式）をご参照ください。  
https://v2.tauri.app/ja/start/prerequisites/  

```bash
# リポジトリのクローン  
git clone https://github.com/DroicheadNua/MirrorShard_2.git  
cd MirrorShard_2  

# 依存関係インストール  
pnpm install  

# ビルド (releaseモード)  
pnpm tauri build
```

ビルドに成功すると、 src-tauri/target/release/bundle/以下にインストーラが生成されます。これをインストールしてご利用ください。  

## 🎵 BGM機能とパフォーマンスについて  

本アプリケーションのBGM機能は、OSによって動作仕様とメモリ消費量が異なります。  

*   **Windows / macOS:**  
    *   設定画面から任意の音楽ファイル（mp3/wav/ogg）を指定して再生する場合、ストリーミング再生となるため**メモリ消費は最小限**に抑えられます。  
*   **Linux (Raspberry Pi含む):**  
    *   OSの制限により、音楽データをすべてメモリ上に展開して再生します。そのため、**BGM使用時はメモリ消費量が増加します。**  
    *   特にRaspberry Pi等の低スペック環境でメモリ不足を感じる場合は、BGMをオフにすることをお勧めします。  
