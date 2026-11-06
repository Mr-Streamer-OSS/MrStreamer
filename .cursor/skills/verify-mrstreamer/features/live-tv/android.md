# Android Explore app

Android Connect > Explore app admits an ephemeral browse session through the real destinations.
`apps/android/src/preview/` supplies fictional local presentation facts without creating a source
or provider. Home, Live, Guide schedules/programmes, Movies, Series and Search use those facts;
content actions use a common provider-required boundary, which opens one Add provider sheet titled
for the action (`apps/android/src/preview/controls.tsx`). A Preview mode strip heads every
destination scene, beside the rail on tablets; its Add provider opens the real form directly and
its close button is Exit preview, as is Back at Live's root. The sheet and form open over the
mounted browse tree, so Keep exploring, Cancel and Back retain its context. Normal connection removes examples, and Exit preview
or process restart restores the source gate without clearing personal data. Source contracts and
rendered library/reminder actions are covered by `apps/android/test/preview.test.ts` and
`apps/android/test/preview-screens.test.ts`. Installed phone/tablet navigation, Back, TalkBack,
large text, provider transition and native effect absence remain separate Android acceptance.
