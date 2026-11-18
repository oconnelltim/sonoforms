# Tools

Helpers for people working on SonoForms. They're not part of the app or the Docker images.

## SR viewer (`sr-viewer/index.html`)

Opens a DICOM Structured Report, such as the measurement report an ultrasound machine sends at the end of a study, and shows what's in it:

- **Summary:** report type and template (e.g. TID 5100 Vascular Ultrasound), device, study and report dates, and the Study Instance UID. Patient identifiers are blurred until you tick *Show patient identifiers*.
- **Measurements:** every numeric item with where it sits in the report (e.g. *Internal Carotid Artery*), side, modifiers (derivation, cardiac cycle point…) and units.
  - Machines often record a measurement several times. The value the machine or tech chose is marked, and the rest are greyed out.
  - Each row has a *mapping key*, the codes that identify the measurement, for wiring it to a form field.
  - Measurements can be downloaded as CSV or JSON.
- **Content tree:** the whole report as a collapsible tree.
- **Vendor data:** private blocks. For GE machines this includes their XML list of every measurement and calculation, stored in SI units and shown converted to the units the machine displayed.
- **All elements:** every DICOM element in the file.

To use it, open `index.html` in a browser (double-click it), then drop an SR file on the page or use *Open SR file…*.

It's a single file with no dependencies, server or install. Everything happens in the browser tab, and its Content-Security-Policy blocks all network access, so the file never leaves the computer. It reads explicit and implicit VR little endian, deflated and big-endian files.

The parser is tested in `test/sr-viewer.test.js`.
