project('gnome-speaks',
  version: '1',
  license: 'GPL-3.0-or-later',
)

uuid = 'gnome-speaks@jphein'

gnome = import('gnome')

datadir = get_option('datadir')
prefix = get_option('prefix')
shell_extensiondir = join_paths(datadir, 'gnome-shell', 'extensions', uuid)

# Extension files
install_data(
  [
    'extension.js',
    'prefs.js',
    'metadata.json',
    'stylesheet.css',
  ],
  install_dir: shell_extensiondir,
)

# GSettings schema
install_data(
  'schemas/org.gnome.shell.extensions.gnome-speaks.gschema.xml',
  install_dir: join_paths(datadir, 'glib-2.0', 'schemas'),
)

gnome.post_install(
  glib_compile_schemas: true,
)

# Service files
service_dir = join_paths(prefix, 'lib', 'systemd', 'user')
dbus_service_dir = join_paths(datadir, 'dbus-1', 'services')

# Python service
install_data(
  'gnome-speaks-service.py',
  install_dir: join_paths(datadir, 'gnome-speaks'),
  install_mode: 'rwxr-xr-x',
)

# Configure and install systemd service
conf = configuration_data()
conf.set('SERVICE_EXEC', join_paths(prefix, datadir, 'gnome-speaks', 'gnome-speaks-service.py'))

configure_file(
  input: 'gnome-speaks.service.in',
  output: 'gnome-speaks.service',
  configuration: conf,
  install: true,
  install_dir: service_dir,
)

configure_file(
  input: 'org.gnome.Speaks.service.in',
  output: 'org.gnome.Speaks.service',
  configuration: conf,
  install: true,
  install_dir: dbus_service_dir,
)
