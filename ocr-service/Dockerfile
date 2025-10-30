FROM python:3.10-slim
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng poppler-utils libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install flask pillow pytesseract pdf2image opencv-python-headless numpy
CMD ["python", "main.py"]
