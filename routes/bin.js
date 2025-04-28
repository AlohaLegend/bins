const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('../index');
const cloudinary = require('cloudinary').v2;
const Jimp = require('jimp');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

router.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ dest: 'uploads/' });

router.get('/', (req, res) => {
  db.query(`SELECT boxNumber FROM bins`, (err, results) => {
    if (err) throw err;
    const usedNumbers = results.map(row => parseInt(row.boxNumber)).filter(n => !isNaN(n));
    let suggestedBoxNumber = 1;
    while (usedNumbers.includes(suggestedBoxNumber)) suggestedBoxNumber++;
    res.render('upload', { suggestedBoxNumber });
  });
});

router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload(req.file.path);
    fs.unlinkSync(req.file.path);
    const { category, location, boxNumber, binName, contents } = req.body;
    const imageUrl = result.secure_url;
    const insertQuery = `INSERT INTO bins (imageUrl, category, location, boxNumber, binName, contents) VALUES (?, ?, ?, ?, ?, ?)`;
    db.query(insertQuery, [imageUrl, category, location, boxNumber, binName, contents], (err, result) => {
      if (err) throw err;
      const binId = result.insertId;
      res.redirect(`/bin/${binId}/qr`);
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Upload failed");
  }
});

router.get('/bin', (req, res) => res.redirect('/bins'));

router.get('/bin/:id', (req, res) => {
  db.query(`SELECT * FROM bins WHERE id = ?`, [req.params.id], (err, results) => {
    if (err) throw err;
    if (!results.length) return res.status(404).send("Bin not found");
    res.render('bin', { 
      bin: results[0], 
      googleApiKey: process.env.GOOGLE_API_KEY 
    });
  });
});

router.get('/bins', (req, res) => {
  db.query(`SELECT * FROM bins ORDER BY createdAt DESC`, (err, results) => {
    if (err) throw err;

    // Extract unique categories
    const categories = [...new Set(results.map(bin => bin.category))];

    res.render('all_bins', { bins: results, categories });
  });
});

router.get('/bin/edit/:id', (req, res) => {
  db.query(`SELECT * FROM bins WHERE id = ?`, [req.params.id], (err, results) => {
    if (err) throw err;
    if (!results.length) return res.send("Bin not found");
    res.render('edit_bin', { bin: results[0] });
  });
});

router.post('/bin/edit/:id', upload.single('image'), async (req, res) => {
  const binId = req.params.id;
  const { category, location, boxNumber, binName, contents } = req.body;


  try {
    // Get current bin info
    db.query(`SELECT * FROM bins WHERE id = ?`, [binId], async (err, results) => {
      if (err) throw err;
      if (results.length === 0) return res.status(404).send("Bin not found");

      const currentBin = results[0];
      let newImageUrl = currentBin.imageUrl;

      // ✅ If a new image was uploaded, upload it to Cloudinary
      if (req.file) {
        const cloudResult = await cloudinary.uploader.upload(req.file.path);
        fs.unlinkSync(req.file.path); // clean up local temp

        newImageUrl = cloudResult.secure_url;

        // Optional: delete old image from Cloudinary if using cloudinary public_id
        // You'll need to store & retrieve public_id for this
        // await cloudinary.uploader.destroy(currentBin.public_id);
      }

      // ✅ Update the database
      db.query(
        `UPDATE bins SET category = ?, location = ?, boxNumber = ?, binName = ?, contents = ? WHERE id = ?`,
        [category, location, boxNumber, binName, contents, req.params.id],
        (err) => {
          if (err) throw err;
          res.redirect('/bins');
        }
      );
    });
  } catch (error) {
    console.error("Edit failed:", error);
    res.status(500).send("Edit failed");
  }
});

router.get('/bin/:id/qr', async (req, res) => {
  const binId = req.params.id;
  db.query(`SELECT * FROM bins WHERE id = ?`, [binId], async (err, results) => {
    if (err) throw err;
    if (!results.length) return res.status(404).send("Bin not found");

    const bin = results[0];
    const qrUrl = `${req.protocol}://${req.get('host')}/bin/${bin.id}?scanned=true`;

    try {
      const qrBuffer = await QRCode.toBuffer(qrUrl, { width: 800, margin: 2, errorCorrectionLevel: 'H' });
      const qrImage = await Jimp.read(qrBuffer);

      // Logo background with rounded corners
      const logo = await Jimp.read('./public/logo_purple.png');
      logo.resize(280, 90);

      const logoBg = new Jimp(logo.bitmap.width + 20, logo.bitmap.height + 20, 0xffffffff);
      const radiusLogo = 40;
      logoBg.scan(0, 0, logoBg.bitmap.width, logoBg.bitmap.height, function (x, y, idx) {
        const w = this.bitmap.width;
        const h = this.bitmap.height;
        const distTL = Math.sqrt(x * x + y * y);
        const distTR = Math.sqrt((w - x) ** 2 + y ** 2);
        const distBL = Math.sqrt(x * x + (h - y) ** 2);
        const distBR = Math.sqrt((w - x) ** 2 + (h - y) ** 2);
        const isCorner = distTL > radiusLogo && distTR > radiusLogo && distBL > radiusLogo && distBR > radiusLogo;
        this.bitmap.data[idx + 3] = isCorner ? 255 : 255;
      });

      logoBg.composite(logo, 10, 10);
      const logoX = (qrImage.bitmap.width - logoBg.bitmap.width) / 2;
      const logoY = (qrImage.bitmap.height - logoBg.bitmap.height) / 2 - 25;
      qrImage.composite(logoBg, logoX, logoY);

      // Box number background + text
      const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
      const boxLabel = `#${bin.boxNumber}`;
      const labelWidth = 120;
      const labelHeight = 40;

      const labelBg = new Jimp(labelWidth, labelHeight, 0xffffffff);
      const radiusLabel = 20;
      labelBg.scan(0, 0, labelWidth, labelHeight, function (x, y, idx) {
        const w = this.bitmap.width;
        const h = this.bitmap.height;
        const distTL = Math.sqrt(x * x + y * y);
        const distTR = Math.sqrt((w - x) ** 2 + y ** 2);
        const distBL = Math.sqrt(x * x + (h - y) ** 2);
        const distBR = Math.sqrt((w - x) ** 2 + (h - y) ** 2);
        const isCorner = distTL > radiusLabel && distTR > radiusLabel && distBL > radiusLabel && distBR > radiusLabel;
        this.bitmap.data[idx + 3] = isCorner ? 255 : 255;
      });

      const label = new Jimp(labelWidth, labelHeight, 0x00000000);
      await label.print(
        font,
        0,
        0,
        {
          text: boxLabel,
          alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
          alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        },
        labelWidth,
        labelHeight
      );

      // Tint text to ab67f4
      label.scan(0, 0, label.bitmap.width, label.bitmap.height, function (x, y, idx) {
        if (this.bitmap.data[idx] === 0 && this.bitmap.data[idx + 1] === 0 && this.bitmap.data[idx + 2] === 0) {
          this.bitmap.data[idx] = 0xab;
          this.bitmap.data[idx + 1] = 0x67;
          this.bitmap.data[idx + 2] = 0xf4;
        }
      });

      const labelX = (qrImage.bitmap.width - labelWidth) / 2;
      const labelY = logoY + logoBg.bitmap.height + 8;

      qrImage.composite(labelBg, labelX, labelY);
      qrImage.composite(label, labelX, labelY);

      const finalQR = await qrImage.getBase64Async(Jimp.MIME_PNG);
      res.render('qr', { bin, qrCode: finalQR });

    } catch (err) {
      console.error("QR code customization failed:", err);
      res.status(500).send("QR generation failed");
    }
  });
});

const PDFDocument = require('pdfkit');
const path = require('path');

router.get('/bin/:id/pdf', (req, res) => {
  const binId = req.params.id;

  db.query(`SELECT * FROM bins WHERE id = ?`, [binId], async (err, results) => {
    if (err || results.length === 0) return res.status(500).send("Bin not found");

    const bin = results[0];
    const doc = new PDFDocument({
      size: [216, 144], // 3x2 inches in points
      margin: 10,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bin_${binId}_card.pdf"`);

    doc.pipe(res);

    // 🔤 Register Roboto Mono font if available
    const fontPath = path.join(__dirname, '../public/fonts/RobotoMono-Regular.ttf');
    if (fs.existsSync(fontPath)) {
      doc.registerFont('RobotoMono', fontPath);
      doc.font('RobotoMono');
    } else {
      doc.font('Courier');
    }

    // 🟣 Center bin name in the top half
    doc
      .fontSize(24)
      .fillColor('#000000')
      .text(bin.binName || 'Unnamed Bin', {
        align: 'center',
        valign: 'top',
        height: 60,
      });

    // 🖼️ Add logo to bottom left
    const logoPath = path.join(__dirname, '../public/logo_purple.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 10, 105, { width: 36 }); // Adjust position as needed
    }

    try {
      // 🔳 Generate QR code buffer
      const qrUrl = `${req.protocol}://${req.get('host')}/bin/${bin.id}?scanned=true`;
      const qrBuffer = await QRCode.toBuffer(qrUrl, {
        width: 300,
        margin: 1,
        errorCorrectionLevel: 'H',
      });

      // 🛠️ Composite logo + text inside QR code using Jimp
      const qrImage = await Jimp.read(qrBuffer);
      const qrLogo = await Jimp.read(logoPath);
      qrLogo.resize(60, 60);

      const centerX = (qrImage.bitmap.width - qrLogo.bitmap.width) / 2;
      const centerY = (qrImage.bitmap.height - qrLogo.bitmap.height) / 2;
      qrImage.composite(qrLogo, centerX, centerY);

      const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
      qrImage.print(
        font,
        0,
        qrImage.bitmap.height - 24,
        {
          text: `#${bin.boxNumber}`,
          alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
        },
        qrImage.bitmap.width
      );

      // 🖨️ Place final QR on bottom right
      const finalQR = await qrImage.getBufferAsync(Jimp.MIME_PNG);
      doc.image(finalQR, 160, 95, { width: 42 });

    } catch (qrErr) {
      console.error("QR generation error:", qrErr);
      doc.fontSize(10).fillColor('red').text('QR Code Error', 160, 110);
    }

    doc.end();
  });
});

router.post('/bin/delete/:id', (req, res) => {
  db.query(`DELETE FROM bins WHERE id = ?`, [req.params.id], (err) => {
    if (err) throw err;
    res.redirect('/bins');
  });
});

router.post('/bin/:id/update-location', async (req, res) => {
  const { lat, lon } = req.body;
  const binId = req.params.id;

  if (!lat || !lon) {
    return res.status(400).send('Missing latitude or longitude');
  }

  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&result_type=street_address|route|intersection&key=${apiKey}`);
    const geoData = await geoRes.json();

    let formattedAddress = `${lat.toFixed(4)}, ${lon.toFixed(4)}`; // Default fallback

    if (geoData.status === "OK" && geoData.results.length > 0) {
      formattedAddress = geoData.results[0].formatted_address;
    }

    const updateQuery = `
      UPDATE bins
      SET location = ?, locationLastUpdated = NOW()
      WHERE id = ?
    `;
    db.query(updateQuery, [formattedAddress, binId], (err) => {
      if (err) {
        console.error('❌ Database update error:', err);
        return res.status(500).send('Database update failed');
      }
      res.send('Location updated');
    });

  } catch (error) {
    console.error('❌ Reverse geocoding failed:', error);
    res.status(500).send('Location update error');
  }
});


router.post('/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.body;

  if (!lat || !lon) {
    return res.status(400).send('Missing latitude or longitude');
  }

  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}`);
    const geoData = await geoRes.json();

    if (geoData.status === "OK" && geoData.results.length > 0) {
      const goodResult = geoData.results.find(result =>
        result.types.includes('street_address') ||
        result.types.includes('premise') ||
        result.types.includes('subpremise')
      );

      const formattedAddress = goodResult
        ? goodResult.formatted_address
        : geoData.results[0]?.formatted_address || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

      res.send({ address: formattedAddress });
    } else {
      res.status(404).send({ address: `Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}` });
    }

  } catch (error) {
    console.error('Reverse geocoding server error:', error);
    res.status(500).send({ address: `Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}` });
  }
});


module.exports = router;
