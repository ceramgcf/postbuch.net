import os
import tempfile
import unittest

import numpy as np
import pikepdf
from PIL import Image

import process_scan


class CombinedContentMaskTest(unittest.TestCase):
    def test_duplex_masks_add_content_from_both_sides(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            front = np.full((20, 30), 255, dtype=np.uint8)
            back = front.copy()
            front[2:6, 3:8] = 0
            back[12:18, 20:27] = 0
            front_path = os.path.join(tmpdir, "front.png")
            back_path = os.path.join(tmpdir, "back.png")
            Image.fromarray(front).save(front_path)
            Image.fromarray(back).save(back_path)

            mask = process_scan.combine_content_masks([front_path, back_path])

            self.assertTrue(mask[3, 4])
            self.assertTrue(mask[14, 22])
            self.assertEqual(
                process_scan.find_content_bbox_in_mask(mask),
                (3, 2, 27, 18),
            )

    def test_different_mask_sizes_abort_common_crop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first_path = os.path.join(tmpdir, "first.png")
            second_path = os.path.join(tmpdir, "second.png")
            Image.new("L", (30, 20), 255).save(first_path)
            Image.new("L", (20, 30), 255).save(second_path)

            with self.assertRaisesRegex(ValueError, "unterschiedliche Größen"):
                process_scan.combine_content_masks([first_path, second_path])

    def test_osd_rotation_parser(self):
        self.assertEqual(process_scan.parse_osd_rotation("Orientation: 3\nRotate: 180\n"), 180)
        self.assertIsNone(process_scan.parse_osd_rotation("Too few characters"))

    def test_inner_content_pixels_ignore_scanner_border(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            page = np.full((100, 100), 255, dtype=np.uint8)
            page[:, :2] = 0
            page_path = os.path.join(tmpdir, "border.png")
            Image.fromarray(page).save(page_path)

            is_blank, content_pixels = process_scan.classify_auto_blank_page(
                page_path, mean=251.0, stddev=10.62,
            )

            self.assertTrue(is_blank)
            self.assertEqual(content_pixels, 0)

    def test_sparse_inner_content_protects_duplex_page(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            page = np.full((100, 100), 255, dtype=np.uint8)
            page[45:55, 45:55] = 0
            page_path = os.path.join(tmpdir, "content.png")
            Image.fromarray(page).save(page_path)

            is_blank, content_pixels = process_scan.classify_auto_blank_page(
                page_path, mean=251.0, stddev=10.62,
            )

            self.assertFalse(is_blank)
            self.assertGreater(content_pixels, process_scan.BLANK_MASK_MAX_CONTENT_PX)

    def test_light_front_side_bleed_does_not_keep_blank_back(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            page = np.full((100, 100), 255, dtype=np.uint8)
            # Sichtbares, aber nur sehr helles Durchscheinen wie bei P000518.
            page[35:65, 35:65] = 210
            page_path = os.path.join(tmpdir, "bleed-through.png")
            Image.fromarray(page).save(page_path)

            is_blank, content_pixels = process_scan.classify_auto_blank_page(
                page_path, mean=251.6, stddev=6.58,
            )

            self.assertTrue(is_blank)
            self.assertEqual(content_pixels, 0)


class MultiPageCropTest(unittest.TestCase):
    def test_crop_box_is_applied_to_every_page(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            src = os.path.join(tmpdir, "src.pdf")
            dst = os.path.join(tmpdir, "dst.pdf")
            with pikepdf.new() as pdf:
                pdf.add_blank_page(page_size=(595, 842))
                pdf.add_blank_page(page_size=(595, 842))
                pdf.save(src)

            process_scan.apply_crop_to_pdf(src, (10, 20, 410, 620), dst)

            with pikepdf.open(dst) as pdf:
                self.assertEqual(len(pdf.pages), 2)
                for page in pdf.pages:
                    self.assertEqual([float(v) for v in page.cropbox], [10, 20, 410, 620])

    def test_uniform_duplex_rotation_keeps_pages_aligned(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            src = os.path.join(tmpdir, "src.pdf")
            dst = os.path.join(tmpdir, "dst.pdf")
            with pikepdf.new() as pdf:
                pdf.add_blank_page(page_size=(595, 842))
                pdf.add_blank_page(page_size=(595, 842))
                pdf.save(src)

            process_scan.apply_uniform_rotation_to_pdf(src, 90, dst)

            with pikepdf.open(dst) as pdf:
                sizes = []
                for page in pdf.pages:
                    mb = page.mediabox
                    sizes.append((round(float(mb[2]) - float(mb[0])), round(float(mb[3]) - float(mb[1]))))
                    self.assertEqual(int(page.obj.get("/Rotate", 0)) % 360, 0)
                self.assertEqual(sizes, [(842, 595), (842, 595)])


if __name__ == "__main__":
    unittest.main()
