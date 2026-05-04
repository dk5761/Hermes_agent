Pod::Spec.new do |s|
  s.name           = 'IosTools'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS tools for Hermes — Calendar, Reminders, Notifications'
  s.description    = 'Expo native module exposing EKEventStore (Calendar + Reminders) ' \
                     'and UNUserNotificationCenter to the Hermes mobile app so the ' \
                     'agent can read and write iOS-native data on-device.'
  s.author         = { 'Hermes' => 'noreply@hermesapp.local' }
  s.homepage       = 'https://github.com/hermesapp/hermes-mobile'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.2' }
  s.source         = { :git => 'https://github.com/hermesapp/hermes-mobile.git', :tag => "v#{s.version}" }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.9'
  s.source_files   = 'ios/**/*.{h,m,swift}'
end
