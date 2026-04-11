If you don’t need vertical writing or DOCX export, you can skip this guide.

# **Pandoc Setup Guide**

MirrorShard 2 can export and print documents in horizontal writing without any external tools.

However, **vertical writing export** and **DOCX export** require **Pandoc**.

---

## ■ 1. Supported Formats

By integrating with the powerful open-source tool **Pandoc**, MirrorShard can export content from the vertical preview as:

* EPUB (eBook format)
* HTML

It also supports:

* Japanese vertical writing
* Ruby annotations (Aozora Bunko style)

---

**Notes:**

* Direct PDF export and printing are not supported
* To generate a PDF:

  1. Export as HTML
  2. Open in a browser (Chrome or Edge)
  3. Use the browser’s print / save as PDF function

**Recommended browsers:**

* Google Chrome
* Microsoft Edge

Other browsers (such as Firefox) may not correctly render vertical text or margins.

---

## ■ 2. Installing Pandoc

---

### a) Download and Install

Pandoc is a universal document converter supporting many formats.

1. Download the installer:
   [https://pandoc.org/installing.html](https://pandoc.org/installing.html)

2. Choose the correct file for your OS:

* **Windows:** `.msi`
* **macOS:** `.pkg`
* **Linux:**

  ⚠️ Use the **official release**, not your distribution’s package manager.
  Older versions may not work correctly.

Example (Debian-based systems):

```id="5e32zp"
sudo dpkg -i your-package.deb
```

3. Run the installer and follow the instructions.

Pandoc should be automatically detected after installation.

---

### b) Setting Pandoc Path (if needed)

If MirrorShard shows **"Pandoc not found"**, set the path manually:

1. Press **F2** to open Settings
2. Find **"Pandoc Path"**
3. Click **"Select..."**
4. Choose the Pandoc executable

Typical locations:

* **Windows:**
  `C:\Program Files\Pandoc\pandoc.exe`
  or
  `C:\Users\<username>\AppData\Local\Pandoc\pandoc.exe`

* **macOS:**
  `/usr/local/bin/pandoc`
  or (Homebrew)
  `/opt/homebrew/bin/pandoc`

  *Note:*
  These folders may be hidden in the file dialog.
  Press **Cmd + Shift + G** and enter the path manually.

* **Linux:**
  Run:

```id="zq5yij"
which pandoc
```

Usually:
`/usr/bin/pandoc`

---

## ■ 3. Reading on Kindle

You can send exported EPUB files to Kindle.

1. Export your document as **EPUB** in MirrorShard
   *(A cover image is required for Kindle)*

2. Go to:
   [https://www.amazon.com/sendtokindle](https://www.amazon.com/sendtokindle)

   Or send the EPUB file to your Kindle email address

3. The book will appear in your Kindle library after a few minutes

---

## ■ 4. Export Procedure

1. Open the vertical preview
2. Click the **Export** icon in the toolbar
3. Select format (EPUB or HTML)

For EPUB:

* Enter title and author
* Set a cover image
* Click **Export**

---

## ■ 5. Notes and Limitations

* This export feature is **simple and lightweight**
* Very large files (multi-megabyte texts) may not export correctly
* YAML metadata may not be fully supported

---

**Limitations:**

* Vertical composition features such as *tate-chu-yoko* are not supported
* Not suitable for professional publishing workflows

---

**Important:**

* Export uses the **current preview content**
* There may be a delay before the preview updates
* Make sure the preview is up to date before exporting

