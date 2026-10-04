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
          glibc
          gdk-pixbuf
          cairo
          glib
          fontconfig
          stdenv.cc.cc.lib
          alsa-lib
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

        version = "1.14.1";

        # プロジェクト直下にmirrorshard2-local-x86_64-linux.tar.gzという名前でTarballがある場合のみそちらを参照してビルド
        localTarball = ./mirrorshard2-local-x86_64-linux.tar.gz;

        in
      {
        # 'nix develop' を実行した際に入り込む開発シェル
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

        # x86_64 Linux向けの配布バイナリ
        packages = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            default = pkgs.stdenv.mkDerivation {
            pname = "mirrorshard2";
            inherit version;

            src =
                if builtins.pathExists localTarball then
                localTarball
                else
                pkgs.fetchurl {
                    url = "https://github.com/DroicheadNua/MirrorShard_2/releases/download/v${version}/mirrorshard2-${version}-x86_64-linux.tar.gz";
                    hash = "sha256-gPwPqCFP72atojlxKuAweHxZNufsWgijxyXx5bVt9H8=";
                };

            sourceRoot = ".";

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.patchelf
            ];

            dontBuild = true;

            installPhase = ''
              mkdir -p $out/lib/mirrorshard2
              mkdir -p $out/bin

              cp mirrorshard2 $out/lib/mirrorshard2/mirrorshard2

              if [ -d resources ]; then
                cp -r resources $out/lib/mirrorshard2/
              fi

              patchelf \
                --set-interpreter "${pkgs.glibc}/lib/ld-linux-x86-64.so.2" \
                --set-rpath "${pkgs.lib.makeLibraryPath runtimeDeps}" \
                $out/lib/mirrorshard2/mirrorshard2

              makeWrapper $out/lib/mirrorshard2/mirrorshard2 $out/bin/mirrorshard2 \
                --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath runtimeDeps}" \
                --prefix GIO_EXTRA_MODULES : "${pkgs.glib-networking}/lib/gio/modules" \
                --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0" \
                --prefix XDG_DATA_DIRS : "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}"
            '';
          };
        };
      }
    );
}
