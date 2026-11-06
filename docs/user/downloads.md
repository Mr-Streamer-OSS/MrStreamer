# Downloads

Download a movie, an episode or a whole series and watch it later on this computer, without a network connection and without a subscription. Pause downloads, reorder the queue, and watch a downloaded series episode after episode.

- **Movies.** **Download** sits beside **Play** and **Save**.
- **Series.** One confirmation queues every remaining episode.
- **Queue.** One download at a time, in your order, with pause and resume.
- **Offline.** Copies play without a network or a subscription, on this computer only.

This guide covers the latest desktop release. See [Updates and channels](updates.md) to update an older installation.

## Downloading

_Download beside Play and Save for a movie or a series, and each episode's own icon._

- **Movies:** open the movie and press **Download**, beside **Play** and **Save**. It downloads the version **Play** would play, so pick another with the arrow beside **Play** first if you want that one.
- **Series:** open **Download**, beside **Play** and **Save**. Its menu names every available season, including Specials, and the selected provider version. Pick another version with Play’s arrow first. Confirm **Download … episodes** to add the remaining episodes to the end of the queue. Each episode uses the file its row would play, including its resumed file when still listed. Already downloaded or queued files are skipped; failed files are retried. A partial result names files that could not be added and offers **Retry**, while successful additions stay in the queue. The menu also offers **Retry failed**, **Cancel the rest** and **Open Downloads**. New episodes need another confirmation.
- **Episodes:** each row keeps a download icon in the same place. Queued, progress, waiting and failure messages appear beside its date and duration; a thin progress bar runs along the still. The icon cancels an unfinished download, resumes a paused one, retries a failed one, or watches a completed copy offline.

A movie’s button then shows how the download stands: **Queued**, its progress, **Waiting for playback**, **Paused** with **Resume**, or what went wrong with **Retry**. Pressing it while it is queued or downloading cancels it, and while it is paused resumes it. Once it is on this computer it reads **Watch offline**, and on a movie the arrow beside it has **Delete download**.

Supported are movies and episodes of Xtream subscriptions and of playlists whose groups you mapped to movies or series. Live channels aren't downloaded; from 0.0.23, now in Nightly, you can [record them](live-tv.md#recordings).

## The Downloads page

_The queue at the top, what is on this computer below._

**Downloads**, the last page in the top bar, has the queue at the top and what is on this computer below. The entry appears while any download is kept, including queued, paused, failed, completed or missing copies. In a narrow window it is the download icon beside Search, with the same rule. Removing the last download hides the entry and leaves an already open Downloads page in place.

While a download runs, waits or is queued, the top bar shows it beside Search, on every page but Downloads: the arrow with its progress, **Waiting** or **Queued**, or **Paused** once only paused downloads are left. **Download stopped** shows when one failed and nothing else is left, until you retry or delete it. Pressing it opens Downloads, also from a title that plays, which stops as **Back** would stop it.

- One download runs at a time, in the queue's order: the order you added them, until you change it. The arrows on a waiting download move it one place up or down. The one running stays first.
- **Pause** stops a download and keeps what it has downloaded. It keeps its place and stays paused, also after a restart and while something plays, until you press **Resume**. **Pause all**, at the top of the page, pauses everything that can be; once everything is paused it reads **Resume all**.
- **Waiting while … plays**: something from the same subscription is playing, a channel, Home's preview or a title, here or on a TV, or, from 0.0.23, [recording](live-tv.md#recordings). Many subscriptions allow one connection. Playback takes it from a download, but says it can't play while recordings hold every connection. The download stops and goes on by itself once that subscription plays and records nothing. A download from another subscription goes on meanwhile.
- **Cancel** stops a download and deletes what it had downloaded.
- A failed download says why: the disk is full and how much to free, the downloads folder can't be written, or what the provider answered. **Retry** queues it again; **Delete** removes it.
- **Watch offline** plays a copy. **Delete** removes it from this computer, after you press it a second time.

The page also shows how much space downloads take and how much is free on that disk.

## Episodes of a series

_Downloaded episodes sit together and play one after another._

Two or more downloaded episodes of the same series version sit together on the Downloads page, under the series' name. Each season lists its episodes in the series' order. An episode the series has between two of yours that isn't on this computer gets a line of its own, such as "S2 E3 isn't on this computer". The arrow beside the name folds the episodes away. Episodes downloaded with an earlier version of the app keep their own rows.

When an episode ends, the next one plays after the countdown if its complete copy is on this computer. **Play now** starts it at once and **Cancel** stays where you are. **Next episode** and its delay in **Settings > Playback** work here too. The next one is always the episode right after it in the series. When that one isn't on this computer, or is still downloading, the end of the episode says so and nothing plays. No missing episode is skipped or streamed instead. Episodes downloaded with an earlier version of the app have no next episode.

Before continuing, Mr. Streamer saves the current episode's progress and checks the download list again for the next episode's complete, present copy. If saving fails, it stays on the current episode and stops the countdown; **Next episode** tries again. An externally removed current file does not prevent continuation once progress saves and the next copy is available. Deleting the current download through the app removes its record and stops its playback.

## Watching offline

_The same player, with no request to your provider._

A copy plays in the same player as everything else: the timeline, the 10-second skips, speed, sound tracks, the file's own subtitles and their timing and look all work. The line under the title says **Offline**. Subtitles you downloaded online for that exact version before it finished downloading come with the copy, with your timing; searching for new ones needs the version from your subscription. A copy plays on this computer only, not on a TV.

From 0.0.24, how far you got in each copy belongs to the Default viewing profile. Existing positions carry over, including after removing a subscription or restarting the app. Transfer and artwork updates leave that position alone. It is separate from your progress in the same title online.

Playing a copy makes no request to your provider. Its details and pictures were saved when you downloaded it. Statistics and update checks still run as set.

## Without a subscription

_Copies stay and play after a subscription ends or is removed._

Copies don't depend on a subscription. When a subscription expires or you remove it, its copies stay and still play; the page says "Subscription removed, copy kept". Removing a subscription cancels its unfinished downloads.

With no subscription saved, the Connect screen shows **Downloads** at the top when there is something to watch, and from 0.0.23 **Recordings** when any are kept. **Add subscription** goes back to the form.

## When a download is interrupted

_It goes on from where it stopped when your provider confirms the same file._

Quitting the app, pausing, or playback taking the connection, keeps the downloaded part. The download goes on from there only when your provider confirms it is still the same file. Otherwise it starts again from the beginning, and says so. A file is only offered for watching once all of it has arrived.

## Closing and quitting

_From 0.0.24, downloads keep running after Close; Quit asks first._

In 0.0.23 and earlier, closing the last window on Windows or Linux stops downloads with their partial files kept.

Closing the window keeps active, queued and waiting downloads running. With downloads alone, the window closes fully, so Home cannot use a provider connection in the background. Open Mr. Streamer from its native menu or launch it again to return.

The native menu shows how many downloads transfer, queue, wait or are paused, with Open, **Pause downloads** or **Resume downloads**, and Quit, which ends in … while it will ask first. On Windows and Linux, when downloads alone keep the app running, **Pause and quit** saves their pauses before exiting. Paused, failed, missing and completed copies alone do not keep the app running. Once all downloads and recording obligations finish, it exits automatically. macOS keeps the app open until Quit.

Explicit Quit asks while downloads can run or a recording is live. Quit retains partial download files for the provider-checked continuation described above. A failed pause save leaves the app open to retry. If background work cannot be read, the confirmation shows the error with **Try again** and **Quit**. Quit still waits for cleanup before closing. Actual transfers, recording capture and receiver playback ask the system to keep the app awake while allowing display sleep. Manual sleep and shutdown still work. Mr. Streamer does not start at login, install a background service or wake the computer.

## Going back to an earlier version

_0.0.19 and earlier ignore pauses and your queue order._

Mr. Streamer 0.0.19 and earlier ignore pauses and your queue order. Unfinished downloads, including paused ones, can run in the order you added them. The saved pause and order fields survive ordinary use there. Back on 0.0.20 or later, unfinished downloads you paused are paused again, and the queue returns to your order.

From 0.0.24, personal resume positions are saved separately. A version before 0.0.24 sees the positions last kept in its download records. Watching there does not replace Default’s positions when you return to 0.0.24.

## Where they are kept

_A managed folder on this computer._

Downloads start in the `downloads` folder inside Mr. Streamer's data folder, listed in the [privacy policy](../privacy.md#on-your-computer). From 0.0.24, choosing another folder changes where future downloads go. Existing copies stay where they are until explicitly moved. On the Downloads page, the line under the heading names the folder new downloads go to, and **Change folder** opens the system's folder picker. Closing the picker changes nothing.

Moving selected finished copies keeps their identity, details, pictures, subtitles and each viewing profile's resume position. The original remains authoritative until the destination files are flushed and their new location is saved. Cancelling a move keeps the original. If a destination disappears or cannot be written, the move reports a failure; reconnect it and restart to recover an interrupted destination before retrying. A successful move can leave an extra original folder if that folder could not be removed.

Each row and each series has a round box to select it. With any selected, a bar offers **Pause**, **Resume**, **Retry**, **Move to** the folder and **Delete**, each sent only for the selected downloads it fits; moving applies to finished copies. **Delete** asks again, naming how many, on a second press. Afterwards the page says how many of how many were done; a download that failed says why on its row and stays selected, and **Try again** runs the action again on those. Copies move one at a time, and one that fails leaves the rest moving. A copy being moved says so on its row, with **Cancel move**, which keeps the original. **Done** clears the selection. Deleting downloads does not delete recordings or unrelated copies. Mr. Streamer manages its copy folders: use **Delete** rather than removing files by hand. A copy whose file is gone shows as missing and can only be deleted.

Versions before 0.0.24 do not understand chosen folders or moved copies. Return to 0.0.24 to use those copies.
