Pod::Spec.new do |s|
  s.name           = 'HermesLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'Bridge for Hermes ActivityKit live activities'
  s.description    = 'Start / update / end Live Activities from JS'
  s.author         = ''
  s.homepage       = ''
  s.platforms      = { :ios => '16.2' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.4'
  s.source_files = 'ios/**/*.{h,m,swift}'
end
