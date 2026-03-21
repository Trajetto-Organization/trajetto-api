class VehicleChecklistRequiredPhotosMissingError extends Error {
  public readonly missingPhotos: string[];
  public readonly errors: string[];

  public readonly fieldsSent: string[];
  public readonly photosSent: string[];

  public readonly existingPhotos: string[];
  public readonly photosToRemove: string[];

  constructor(
    missingPhotos: string[],
    errors: string[],
    fieldsSent: string[] = [],
    photosSent: string[] = [],
    existingPhotos: string[] = [],
    photosToRemove: string[] = [],
  ) {
    super("Fotos obrigatórias não fornecidas para os campos alterados");
    this.name = "RequiredPhotosMissingError";
    this.missingPhotos = missingPhotos;
    this.errors = errors;
    this.fieldsSent = fieldsSent;
    this.photosSent = photosSent;
    this.existingPhotos = existingPhotos;
    this.photosToRemove = photosToRemove;
  }
}

export { VehicleChecklistRequiredPhotosMissingError };
