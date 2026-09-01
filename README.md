# Monarch Image Sender

App web estática (sin build) para mandarle una imagen a la Monarch por Wi-Fi. Pareja
de [MonarchImageReceiver](../MonarchImageReceiver), que corre en el dispositivo.

## Uso

1. Sirve esta carpeta con cualquier servidor estático, por ejemplo:

   ```
   cd MonarchImageSender
   python3 -m http.server 8000
   ```

   y abre `http://localhost:8000` (o la IP de tu laptop) desde cualquier dispositivo
   en la misma red Wi-Fi que la Monarch — celular, tablet, otra laptop, etc.

2. Escribe la IP que la Monarch muestra en pantalla al abrir MonarchImageReceiver, y
   dale "Conectar" (llama a `GET /info` para saber el tamaño real de la pantalla braille).
3. Elige una imagen (archivo o cámara). Se muestra una vista previa aproximada de cómo
   quedará en braille (mismo algoritmo de dithering que corre en el dispositivo).
4. "Enviar a la Monarch" — hace `POST /image` con la imagen (reescalada a máx. 900px de
   lado para no tardar en la subida; el dispositivo la reescala de nuevo a su tamaño real).

## Notas

- Requiere que ambos dispositivos estén en la misma red local — no hay relay a internet.
- Todo el procesamiento final (el que realmente se muestra) ocurre en el dispositivo;
  la vista previa aquí es solo una aproximación para componer la imagen antes de enviarla.
