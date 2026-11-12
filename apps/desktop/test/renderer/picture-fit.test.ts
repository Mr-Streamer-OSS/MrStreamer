import { expect, it } from "vitest";
import { pictureBox } from "../../src/renderer/src/player/picture-fit.ts";

it("places the picture at the viewer's aspect, crop and zoom", () => {
  const wide = { width: 1600, height: 900 };
  const unchanged = { aspect: "source", crop: "none", zoom: 100 } as const;
  // A 4:3 broadcast keeps its shape, with bars at the sides.
  expect(pictureBox({ width: 720, height: 576 }, wide, { ...unchanged, aspect: "4:3" })).toEqual({
    left: 200,
    top: 0,
    width: 1200,
    height: 900,
  });
  // A 16:9 film in a 4:3 frame: cutting to 16:9 fills the window and cuts the frame's bars.
  expect(pictureBox({ width: 640, height: 480 }, wide, { ...unchanged, crop: "16:9" })).toEqual({
    left: 0,
    top: -150,
    width: 1600,
    height: 1200,
  });
  // Zoom enlarges around the centre; the window cuts what leaves it.
  expect(pictureBox({ width: 1920, height: 1080 }, wide, { ...unchanged, zoom: 150 })).toEqual({
    left: -400,
    top: -225,
    width: 2400,
    height: 1350,
  });
  // The stream's own shape waits for its first frame.
  expect(pictureBox({ width: 0, height: 0 }, wide, { ...unchanged, zoom: 150 })).toBeNull();
});
