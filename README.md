# DocTranslator

Penerjemah dokumen gratis yang berjalan sepenuhnya di browser — mirip
[onlinedoctranslator.com](https://www.onlinedoctranslator.com/id/translationform),
tetapi **tanpa server, tanpa akun, dan tanpa batas halaman**.

Situs ini adalah aplikasi statis (HTML + CSS + JavaScript) sehingga bisa langsung
di-hosting di **GitHub Pages**, Netlify, Vercel, Cloudflare Pages, atau server apa pun.

> **Demo:** `https://agusfm97.github.io/doc-translator/` (setelah halaman GitHub diaktifkan)

---

## Format yang didukung

| Format | Hasil |
| --- | --- |
| **DOCX** | Paragraf, tabel, gambar, header/footer, dan gaya teks tetap utuh |
| **PDF** | Mode *pertahankan tata letak* (halaman asli + teks baru) atau *susun ulang teks* |
| **PPTX** | Semua slide dan catatan pembicara; desain tidak berubah |
| **XLSX** | Sel, komentar, dan format angka; rumus tidak disentuh |
| **TXT / MD / CSV** | Struktur baris terjaga; blok kode Markdown dilewati |
| **SRT / VTT** | Nomor dan timestamp tidak diubah |
| **HTML** | Tag dan atribut tetap; hanya teks yang diterjemahkan |

Bahasa: 80+ bahasa termasuk Indonesia, Jawa, Sunda, Inggris, Mandarin, Jepang,
Korea, Arab, Hindi, dan bahasa-bahasa Eropa.

---

## Cara kerja

1. File dibaca **di perangkat pengunjung** memakai `JSZip` (Office), `pdf.js` (PDF),
   dan `DOMParser` (HTML/XML).
2. Teks dikumpulkan per paragraf/segmen, lalu dikirim ke endpoint publik
   Google Translate (`translate.googleapis.com`) dalam beberapa permintaan.
3. Hasil terjemahan ditulis kembali ke struktur file asli, lalu file diunduh.
4. File **tidak pernah** diunggah ke server aplikasi ini.

Batas praktis: ukuran file 60 MB dan 10 file per proses (agar browser tidak kehabisan memori).

---

## Menjalankan secara lokal

Tidak perlu build tool apa pun.

```powershell
cd "C:\Users\User\Documents\Default Project\doc-translator-web"
python -m http.server 8080
```

Buka <http://localhost:8080>.

> Membuka `index.html` langsung lewat `file://` tidak disarankan karena ES module
> dan worker pdf.js membutuhkan server HTTP.

---

## Deploy ke GitHub Pages

### Cara 1 — otomatis dengan skrip (Windows)

1. Buat **Personal Access Token** di <https://github.com/settings/tokens>
   (klasik, centang scope **`repo`**).
2. Jalankan:

```powershell
cd "C:\Users\User\Documents\Default Project\doc-translator-web"
powershell -ExecutionPolicy Bypass -File .\deploy-gh.ps1
```

3. Tempel token saat diminta. Skrip akan:
   - membuat repositori `doc-translator` (jika belum ada),
   - mengunggah semua file,
   - mengaktifkan GitHub Pages dari branch `main`.

Situs aktif di **https://agusfm97.github.io/doc-translator/** dalam 1–2 menit.

### Cara 2 — manual lewat GitHub

1. Buat repositori baru bernama `doc-translator` (public).
2. Unggah seluruh isi folder ini ke root repositori.
3. Buka **Settings → Pages**.
4. Bagian **Build and deployment** → Source: **Deploy from a branch**.
5. Pilih branch **`main`** dan folder **`/ (root)`** → **Save**.
6. Tunggu status *Your site is live at …*.

### Cara 3 — dengan Git

```bash
git init
git add .
git commit -m "DocTranslator: penerjemah dokumen di browser"
git branch -M main
git remote add origin https://github.com/agusfm97/doc-translator.git
git push -u origin main
```

Lalu aktifkan Pages seperti langkah 3–6 di atas.

---

## Struktur proyek

```
doc-translator-web/
├─ index.html                 # halaman utama
├─ assets/
│  ├─ css/style.css
│  └─ js/
│     ├─ app.js               # UI, pemilih bahasa, unggah, progres, unduhan
│     ├─ languages.js         # daftar 80+ bahasa
│     ├─ translator.js        # mesin terjemahan (batching, retry, cache)
│     └─ formats/
│        ├─ index.js          # registri format
│        ├─ ooxml.js          # helper ZIP/XML + pembagian teks
│        ├─ docx.js
│        ├─ pptx.js
│        ├─ xlsx.js
│        ├─ text.js           # TXT, MD, CSV, SRT, VTT, HTML
│        └─ pdf.js           # render + overlay teks terjemahan
├─ .nojekyll                  # agar GitHub Pages tidak memproses Jekyll
├─ 404.html
├─ robots.txt
├─ LICENSE
├─ deploy-gh.ps1
└─ README.md
```

Pustaka pihak ketiga dimuat dari CDN:

- [JSZip 3.10](https://stuk.github.io/jszip/) — membaca/menulis arsip Office
- [pdf.js 4.10](https://mozilla.github.io/pdf.js/) — membaca PDF
- [jsPDF 2.5](https://github.com/parallax/jsPDF) — menyusun PDF hasil

---

## Kustomisasi cepat

| Ingin mengubah | File |
| --- | --- |
| Warna, radius, font | `assets/css/style.css` (variabel di `:root`) |
| Daftar bahasa | `assets/js/languages.js` |
| Nama situs dan teks halaman | `index.html` |
| Nama file hasil | `assets/js/formats/index.js` → `outputName()` |
| Batas ukuran file | `assets/js/app.js` → `MAX_SIZE`, `MAX_FILES` |

---

## Batasan yang perlu diketahui

- **PDF hasil pindai** (gambar) tidak bisa diterjemahkan karena tidak memiliki lapisan teks.
- **PDF hasil terjemahan** disusun sebagai halaman gambar beresolusi tinggi (teks
  digambar ulang di atas halaman asli). Tampilan dan tata letak terjaga, tetapi
  teks pada PDF hasil belum bisa dipilih, disalin, atau dicari. Format Office
  (DOCX/PPTX/XLSX) dan HTML tetap berupa teks asli.
- PDF dengan teks miring/vertikal rumit bisa memiliki posisi yang kurang sempurna;
  gunakan mode **Susun ulang teks** bila hasilnya sulit dibaca.
- Format Office lama (`.doc`, `.ppt`, `.xls`) harus disimpan ulang sebagai
  `.docx`, `.pptx`, `.xlsx`.
- Kualitas terjemahan sepenuhnya berasal dari Google Translate.
- Endpoint Google yang dipakai bersifat publik dan tanpa jaminan; bila Google
  membatasi permintaan, aplikasi akan mencoba ulang beberapa kali.

---

## Lisensi

MIT © 2026 [agusfm97](https://github.com/agusfm97)
