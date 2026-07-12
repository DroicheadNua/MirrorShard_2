# ビルド用のshell.nix
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
buildInputs = with pkgs; [
    nodejs_22
    pnpm
    rustup

    # GStreamer (音響システム用)
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad

    # システムライブラリ
    pkg-config
    dbus
    openssl
    glib
    glib-networking
    gtk3
    libsoup_3
    webkitgtk_4_1
    libappindicator-gtk3
  ];

shellHook = ''
    # GIOに glib-networking の場所を教えて、TLS/HTTPS通信を有効化する
    export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules"

    # GStreamerのパス
    export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0"

    # C言語ライブラリのパス
    export PKG_CONFIG_PATH="${pkgs.openssl.dev}/lib/pkgconfig:${pkgs.glib.dev}/lib/pkgconfig:${pkgs.gtk3.dev}/lib/pkgconfig:${pkgs.libsoup_3.dev}/lib/pkgconfig:${pkgs.webkitgtk_4_1.dev}/lib/pkgconfig:${pkgs.libappindicator-gtk3.dev}/lib/pkgconfig"
    export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [ pkgs.openssl pkgs.glib pkgs.gtk3 pkgs.libsoup_3 pkgs.webkitgtk_4_1 pkgs.libappindicator-gtk3 ]}"

    echo "❄️ MirrorShard 2 Nix-Shell Activated! ❄️"
  '';
}
