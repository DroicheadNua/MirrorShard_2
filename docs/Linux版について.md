# Linux環境での運用について  

v0.3.0以降、MirrorShard 2のLinuxバイナリの配布を停止いたします。  
これは、LinuxのGUI環境（特にTauriが依存するWebKitGTK）の仕様に起因する、環境依存の不具合が多岐にわたり、開発者の技量では解決できなかったからです。  

## ■ 既知の問題（配布停止の理由）  

以下の環境においては、正常に動作しないことが確認されています。  

1.  **Nvidia製グラフィックボード搭載機:**  
    *   描画が正常に行われず、起動しない（あるいは起動しても描画されない）ケースがあります。  
2.  **Wayland環境 (Raspberry Pi OS Bookworm 標準など):**  
    *   マウスの座標計算が狂い、クリックやドラッグによる範囲選択が正常に機能しません。  
    *   回避するには `GDK_BACKEND=x11` などの環境変数でX11互換モードを強制する必要がありますが、完全な動作は保証できません。  
3.  **IME (日本語入力):**  
    *   WebKitGTKの仕様により、変換候補ウィンドウの表示位置がカーソルに追従しない、インライン入力ができない等の挙動が見られます（入力自体は可能です）。  
  
## ■ 利用可能な環境  
逆に言えば、  
・Nvidia製グラフィックボードを使用していない  
・X11環境 (またはXWaylandが正常に機能する環境)  
のPCであれば、動作させることは可能です。  
IMEの表示不具合は残るものの、Electron版に較べて起動・動作とも高速でファイルサイズも小さく、巨大なテキストファイルも軽快に扱えます。    
特に「Raspberry Pi＋MX Linux（Xfceデスクトップ）」などのシングルボードコンピュータとか、「Windows11非対応の旧型機（グラフィックボードなし）に軽量Linuxを入れた再生PC」のような低スペックPCでは、有力な選択肢になるかもしれません。  

## ■ 利用方法（ビルド）  

上記の制約を理解した上で、ご自身の環境でMirrorShard 2を利用したい場合は、GitHubのリポジトリからソースコードを取得し、ビルドを行ってください。  

**必要なもの:**  
*   Rust (Cargo)  
*   Node.js & pnpm  
*   WebKitGTK 開発ライブラリ (Debian系なら `libwebkit2gtk-4.0-dev` 等)  

```bash  
# クローン  
git clone https://github.com/DroicheadNua/MirrorShard_2.git  
cd MirrorShard_2  

# 依存関係インストール  
pnpm install  

# ビルド (releaseモード)  
pnpm tauri build  

ビルドに成功すると、 src-tauri/target/release/bundle/deb/ (または rpm, appimage) 等にインストーラが生成されます。これをインストールしてご利用ください。  
