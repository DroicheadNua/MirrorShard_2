{
  description = "MirrorShard 2 - AI-powered integrated writing environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # 実行に必要なライブラリ群
        runtimeDeps = with pkgs; [
          gtk3
          libsoup_3
          webkitgtk_4_1
          libappindicator-gtk3
          glib-networking
          gsettings-desktop-schemas
          openssl
          dbus
          gst_all_1.gstreamer
          gst_all_1.gst-plugins-base
          gst_all_1.gst-plugins-good
          gst_all_1.gst-plugins-bad
        ];

        # 開発・ビルド時にのみ必要なツール群
        buildDeps = with pkgs; [
          nodejs_22
          pnpm
          rustup
          pkg-config
        ];

      in
      {
        # 'nix develop' を実行した際に入り込む開発シェル
        # (従来の nix-shell と同じ開発用の正しい環境変数が自動セットアップされる)
        devShells.default = pkgs.mkShell {
          buildInputs = runtimeDeps ++ buildDeps;

          shellHook = ''
            export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules"
            export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0"
            export PKG_CONFIG_PATH="${pkgs.openssl.dev}/lib/pkgconfig:${pkgs.glib.dev}/lib/pkgconfig:${pkgs.gtk3.dev}/lib/pkgconfig:${pkgs.libsoup_3.dev}/lib/pkgconfig:${pkgs.webkitgtk_4_1.dev}/lib/pkgconfig:${pkgs.libappindicator-gtk3.dev}/lib/pkgconfig"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeDeps}"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"

            echo "❄️ MirrorShard 2 Nix Flake Developer Shell Activated! ❄️"
          '';
        };

        # 'nix build' で出力される実行パッケージの定義
        # すでに手動で「pnpm tauri build」されたバイナリをマウントし
        # NixOSに必要なGTK/GSettings/GIO/GStreamerのすべての依存パスを埋め込んだ
        # 「完全に自律したラッパーバイナリ」を出力
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "mirrorshard2";
          version = "1.12.0"; # バージョンに合わせて変更

          # プロジェクト全体ではなくリリースバイナリが存在するディレクトリだけをソースにする
          # これによりnode_modules等の不要なコピーを完全にスキップ
          src = ./src-tauri/target/release;

          buildInputs = runtimeDeps;
          nativeBuildInputs = [ pkgs.makeWrapper ];

          dontBuild = true;

          # ソースのルートが「release」ディレクトリになったため、直接そこからコピー
          installPhase = ''
                      # 1. 本物のバイナリとリソースを、名前を変えずに $out/lib/mirrorshard2/ 以下に退避させる
                      mkdir -p $out/lib/mirrorshard2
                      mkdir -p $out/bin

                      if [ -f mirrorshard2 ]; then
                        # ドットを付けず、正規の名前「mirrorshard2」のままコピー
                        cp mirrorshard2 $out/lib/mirrorshard2/mirrorshard2

                        # そのすぐ隣（同階層）に resources フォルダを配置
                        if [ -d resources ]; then
                          cp -r resources $out/lib/mirrorshard2/
                        fi
                      else
                        echo "Error: Run 'pnpm tauri build' first!"
                        exit 1
                      fi

                      # 2. $out/bin/mirrorshard2 をラッパースクリプトとし、
                      #    上記で退避させた本物のバイナリ（$out/lib/mirrorshard2/mirrorshard2）を環境変数付きで呼び出す
                      makeWrapper $out/lib/mirrorshard2/mirrorshard2 $out/bin/mirrorshard2 \
                        --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath runtimeDeps}" \
                        --prefix GIO_EXTRA_MODULES : "${pkgs.glib-networking}/lib/gio/modules" \
                        --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0" \
                        --prefix XDG_DATA_DIRS : "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}"
                    '';
        };
      }
    );
}
