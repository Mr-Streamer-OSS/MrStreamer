Pod::Spec.new do |s|
  s.name           = 'KeyCommands'
  s.version        = '1.0.0'
  s.summary        = 'The app\'s hardware keyboard shortcuts, listed while Command is held.'
  s.author         = 'Mr. Streamer'
  s.homepage       = 'https://mrstreamer.app'
  s.license        = 'GPL-3.0-only'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
